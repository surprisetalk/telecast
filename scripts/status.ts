import db from "postgres";

const SITE = "https://telecast.company";
const REPO = "surprisetalk/telecast";
const TIMEOUT_MS = 10_000;
// Neon wakes from suspend in a few seconds, and the two counts scan every channel row. snitch kills a status command at 300 s.
const DB_TIMEOUT_MS = 150_000;
// A run or a refresh up to 5 min in the future is clock skew. Beyond that, the clock or the data is wrong.
const SKEW_S = 300;
const DAY_S = 86_400;
const SEARCH_URL = `${SITE}/search?q=tag:featured`;
// telecast-web on pc may not reach pc's own loopback or LAN. The systemd fence drops the packets, so a fenced fetch
// times out. Nothing listens on port 1, so an unfenced fetch is refused at once.
const FENCE_TARGET = "http://127.0.0.1:1/";
const FENCE_URL = `${SITE}/proxy/rss/${encodeURIComponent(FENCE_TARGET)}`;
// The feed proxy waits 15 s on a dropped connection before it answers 502.
const FENCE_TIMEOUT_MS = 30_000;
const runsUrl = (workflow: string) => `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs?status=success&per_page=1`;

type Measured<T> = { ok: T } | { error: string };

export type Measurements = {
  search: Measured<number>;
  db: Measured<{ freshS: number | null; refreshed: number; failed: number; bytes: number }>;
  curate: Measured<number | null>;
  seed: Measured<number | null>;
  fence: Measured<boolean>;
};

export function grade(m: Measurements): { name: string; score: number }[] {
  const db = "ok" in m.db ? m.db.ok : null;
  const age = (r: Measured<number | null>, limitS: number) => "ok" in r && r.ok !== null ? limitS / Math.max(r.ok, 1) : 0;
  const cs = [
    { name: "/search?q=tag:featured answers 200 within 2 s.", score: "ok" in m.search ? 2000 / Math.max(m.search.ok, 1) : 0 },
    { name: "A feed refreshed in the past 15 min.", score: db?.freshS != null ? 900 / Math.max(db.freshS, 1) : 0 },
    {
      name: "At most 20% of channels refreshed in the past 24h failed.",
      score: db && db.refreshed > 0 ? (1 - db.failed / db.refreshed) / 0.8 : 0,
    },
    { name: "Curate succeeded in the past 2 days.", score: age(m.curate, 2 * DAY_S) },
    { name: "Seed succeeded in the past 8 days.", score: age(m.seed, 8 * DAY_S) },
    { name: "The database is smaller than 50 GB.", score: db ? 50e9 / db.bytes : 0 },
    { name: "The feed proxy cannot reach pc's loopback.", score: "ok" in m.fence && m.fence.ok ? 1 : 0 },
  ];
  for (const c of cs) {
    if (!Number.isFinite(c.score)) {
      throw new Error(
        `Expected a finite score for "${c.name}", received ${c.score}, from measurements ${
          JSON.stringify(m)
        }. A probe in scripts/status.ts let a non-finite or zero value through.`,
      );
    }
  }
  return cs;
}

async function measured<T>(what: string, ms: number, f: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { ok: await f() };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError"
      ? `Timed out after ${ms} ms ${what}`
      : e instanceof Error
      ? e.message
      : String(e);
    return { error: msg };
  }
}

async function searchMs(): Promise<number> {
  const url = SEARCH_URL;
  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  const ms = performance.now() - t0;
  if (res.status !== 200) throw new Error(`Expected HTTP 200 from ${url}, received ${res.status} ${res.statusText}.`);
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error(`Expected a JSON array of featured channels from ${url}, received: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Expected a non-empty JSON array of featured channels from ${url}, received: ${body.slice(0, 200)}`);
  }
  return ms;
}

export function fenceHolds(status: number, body: string): boolean {
  if (status === 502 && body.startsWith("Network error fetching") && body.includes("Timed out after")) return true;
  if (status === 400 || status === 502) return false;
  throw new Error(
    `Expected 502 or 400 from ${FENCE_URL}, received ${status}: ${body.slice(0, 200)}. Check the feed proxy in functions/proxy/rss.`,
  );
}

async function fenceProbe(): Promise<boolean> {
  const res = await fetch(FENCE_URL, { signal: AbortSignal.timeout(FENCE_TIMEOUT_MS) });
  return fenceHolds(res.status, await res.text());
}

// Unauthenticated GitHub API: 60 requests/h per IP. The repo is public.
async function lastSuccessS(workflow: string): Promise<number | null> {
  const url = runsUrl(workflow);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/vnd.github+json" } });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`Expected HTTP 200 from ${url}, received ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  let json: { workflow_runs?: { created_at?: unknown }[] } | null;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON {workflow_runs: [...]} from ${url}, received: ${body.slice(0, 200)}`);
  }
  const runs = json?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`Expected {workflow_runs: [...]} from ${url}, received ${JSON.stringify(json).slice(0, 200)}`);
  if (runs.length === 0) return null;
  const createdAt = runs[0]?.created_at;
  const at = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(at)) {
    throw new Error(`Expected an ISO created_at in the first run from ${url}, received ${JSON.stringify(createdAt)}`);
  }
  const ageS = (Date.now() - at) / 1000;
  if (ageS < -SKEW_S) {
    throw new Error(
      `Expected the last ${workflow} run in the past, received created_at ${new Date(at).toISOString()}. Check this host's clock.`,
    );
  }
  return ageS;
}

export async function dbStats(url: string) {
  let password: string;
  try {
    password = new URL(url).password;
  } catch {
    // The URL holds a password, so the message must not echo it.
    throw new Error("DATABASE_URL is not a valid URL. Expected postgres://user:password@host/db. Fix it in .env.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(password);
  } catch {
    throw new Error("DATABASE_URL's password is not percent-encoded. Expected each % in it written as %25. Fix it in .env.");
  }
  const redact = (msg: string) => password ? msg.replaceAll(password, "***").replaceAll(decoded, "***") : msg;
  const sql = db(url, { max: 1, idle_timeout: 5, connect_timeout: 30, connection: { statement_timeout: DB_TIMEOUT_MS - 30_000 } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [r] = await Promise.race([
      sql<{ fresh_s: unknown; refreshed: unknown; failed: unknown; bytes: unknown }[]>`
        select
          extract(epoch from now() - max(last_success_at))::float8 as fresh_s,
          count(*) filter (where greatest(last_success_at, last_error_at) > now() - interval '24 hours')::int as refreshed,
          count(*) filter (
            where last_error_at > now() - interval '24 hours' and last_error_at > coalesce(last_success_at, '-infinity')
          )::int as failed,
          pg_database_size(current_database())::float8 as bytes
        from channel
      `,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${DB_TIMEOUT_MS} ms querying the channel table`)), DB_TIMEOUT_MS);
      }),
    ]);
    const finite = (v: unknown, min: number) => typeof v === "number" && Number.isFinite(v) && v >= min;
    if (
      !r || !(r.fresh_s === null || finite(r.fresh_s, -SKEW_S)) || !finite(r.refreshed, 0) || !finite(r.failed, 0) ||
      (r.failed as number) > (r.refreshed as number) || !finite(r.bytes, 1)
    ) {
      throw new Error(
        `Expected one row {fresh_s >= -${SKEW_S} or null, 0 <= failed <= refreshed, bytes >= 1}, received ${JSON.stringify(r)}`,
      );
    }
    return { freshS: r.fresh_s as number | null, refreshed: r.refreshed as number, failed: r.failed as number, bytes: r.bytes as number };
  } catch (e) {
    throw new Error(redact(e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error(
      "DATABASE_URL is missing. Expected a postgres URL in .env. Received undefined. Copy it from the Neon console into .env.",
    );
  }
  const [search, stats, curate, seed, fence] = await Promise.all([
    measured(`fetching ${SEARCH_URL}`, TIMEOUT_MS, searchMs),
    measured("querying the channel table", DB_TIMEOUT_MS, () => dbStats(url)),
    measured(`fetching ${runsUrl("curate.yml")}`, TIMEOUT_MS, () => lastSuccessS("curate.yml")),
    measured(`fetching ${runsUrl("seed.yml")}`, TIMEOUT_MS, () => lastSuccessS("seed.yml")),
    measured(`fetching ${FENCE_URL}`, FENCE_TIMEOUT_MS, fenceProbe),
  ]);
  const m: Measurements = { search, db: stats, curate, seed, fence };
  // snitch parses from the first line that starts with "{", so a reason line stays on one line.
  for (const [name, r] of Object.entries(m)) if ("error" in r) console.log(`${name}: ${r.error.replace(/\s+/g, " ")}`);
  if ("ok" in stats && stats.ok.freshS === null) console.log("db: no channel has a last_success_at");
  if ("ok" in stats && stats.ok.refreshed === 0) console.log("db: no channel was refreshed in the past 24h");
  if ("ok" in fence && !fence.ok) {
    console.log(`fence: ${FENCE_URL} answered without a timeout, so the proxy may reach ${FENCE_TARGET}.`);
  }
  for (const [name, r] of [["curate", curate], ["seed", seed]] as const) {
    if ("ok" in r && r.ok === null) console.log(`${name}: no successful run on GitHub Actions`);
  }
  const cs = grade(m);
  console.log(
    cs.map((c, i) => `${i ? "," : "{"} ${JSON.stringify(c.name)}: { "0": ${Math.floor(c.score * 100) / 100} }`).join("\n") + "\n}",
  );
  if (cs.some((c) => c.score < 1)) Deno.exit(1);
}
