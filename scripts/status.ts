import db from "postgres";

const SITE = "https://telecast.company";
const TIMEOUT_MS = 10_000;
// The two counts scan every channel row. snitch kills a status command at 300 s.
const DB_TIMEOUT_MS = 150_000;
// A run or a refresh up to 5 min in the future is clock skew. Beyond that, the clock or the data is wrong.
const SKEW_S = 300;
const DAY_S = 86_400;
const SEARCH_URL = `${SITE}/search?q=tag:featured`;
// telecast-web on pc may not reach pc's own loopback or LAN. The systemd fence drops the packets, so a fenced fetch
// times out. Nothing listens on port 2, so an unfenced fetch is refused at once. fetch itself refuses port 1.
const FENCE_TARGET = "http://127.0.0.1:2/";
const FENCE_URL = `${SITE}/proxy/rss/${encodeURIComponent(FENCE_TARGET)}`;
// The feed proxy waits 15 s on a dropped connection before it answers 502.
const FENCE_TIMEOUT_MS = 30_000;
// systemd logs this MESSAGE_ID with JOB_RESULT=done when a unit's start job succeeds: for a oneshot, a run that exited 0.
const JOB_DONE_ID = "39f53479d3a045ac8e11786248231fbf";

type Measured<T> = { ok: T } | { error: string };

export type Measurements = {
  search: Measured<number>;
  db: Measured<{ freshS: number | null; refreshed: number; failed: number; bytes: number }>;
  curate: Measured<number | null>;
  seed: Measured<number | null>;
  fence: Measured<boolean>;
  cache: Measured<number>;
  disk: Measured<{ availBytes: number; sizeBytes: number }>;
};

export function grade(m: Measurements): { name: string; score: number }[] {
  const db = "ok" in m.db ? m.db.ok : null;
  const disk = "ok" in m.disk ? m.disk.ok : null;
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
    { name: "cache/ holds less than 5 GB.", score: "ok" in m.cache ? 5e9 / Math.max(m.cache.ok, 1) : 0 },
    { name: "The disk that holds cache/ has 10% free.", score: disk ? disk.availBytes / disk.sizeBytes / 0.1 : 0 },
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
  if (status === 502 && body.startsWith("Network error fetching")) return body.includes("Timed out after");
  if ((status === 400 && body.startsWith("Not a valid feed")) || (status === 502 && body.startsWith("Upstream feed fetch failed"))) {
    return false;
  }
  throw new Error(
    `Expected a 502 "Network error fetching ..." from the feed proxy at ${FENCE_URL}, received ${status}: ${
      body.slice(0, 200)
    }. Check that telecast-web on pc serves the site.`,
  );
}

async function fenceProbe(): Promise<boolean> {
  const res = await fetch(FENCE_URL, { signal: AbortSignal.timeout(FENCE_TIMEOUT_MS) });
  return fenceHolds(res.status, await res.text());
}

// telecast-web writes cache/ in the repo, and deno task runs in the repo, so the relative paths match.
const CACHE_DIRS = ["cache/rss", "cache/thumb"];

export async function cacheBytes(dirs: string[]): Promise<number> {
  let total = 0;
  for (const dir of dirs) {
    for await (const e of Deno.readDir(dir)) {
      try {
        total += (await Deno.stat(`${dir}/${e.name}`)).size;
      } catch (err) {
        // The server's put or sweep removed the file after readDir listed it.
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
    }
  }
  return total;
}

// POSIX df -P: a header line, then "filesystem 1024-blocks used available capacity mountpoint". The file system name can hold
// spaces (macOS "map auto_home"), so the columns count back from the capacity field, the one that ends in %.
export function parseDf(text: string): { availBytes: number; sizeBytes: number } {
  const fields = text.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
  const cap = fields.findIndex((f) => /^\d+%$/.test(f));
  const sizeBytes = Number(fields[cap - 3]) * 1024, availBytes = Number(fields[cap - 1]) * 1024;
  if (cap < 3 || !(sizeBytes > 0) || !(availBytes >= 0)) {
    throw new Error(`Expected df -Pk cache to print a size and free space in KiB, received: ${text.slice(0, 200)}`);
  }
  return { availBytes, sizeBytes };
}

async function diskFree(): Promise<{ availBytes: number; sizeBytes: number }> {
  const out = await new Deno.Command("df", { args: ["-Pk", "cache"], signal: AbortSignal.timeout(TIMEOUT_MS) }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`Expected df -Pk cache to exit 0, received exit ${out.code}: ${text.slice(0, 200)}`);
  return parseDf(text);
}

export function lastFinishAgeS(unit: string, stdout: string, nowMs: number): number | null {
  const last = stdout.trim().split("\n").at(-1);
  if (!last) return null;
  let us: unknown;
  try {
    us = JSON.parse(last).__REALTIME_TIMESTAMP;
  } catch {
    throw new Error(`Expected journalctl JSON lines for ${unit}, received: ${last.slice(0, 200)}`);
  }
  const at = Number(us) / 1000;
  if (!(at > 0)) throw new Error(`Expected __REALTIME_TIMESTAMP in microseconds for ${unit}, received ${JSON.stringify(us)}`);
  const ageS = (nowMs - at) / 1000;
  if (ageS < -SKEW_S) {
    throw new Error(`Expected the last ${unit} run in the past, received ${new Date(at).toISOString()}. Check this host's clock.`);
  }
  return ageS;
}

// The journal outlives a reboot, so a weekly job keeps its last success across one.
async function lastSuccessS(unit: string): Promise<number | null> {
  const out = await new Deno.Command("journalctl", {
    args: [`--unit=${unit}`, `MESSAGE_ID=${JOB_DONE_ID}`, "JOB_RESULT=done", "--lines=1", "--output=json", "--no-pager"],
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`Expected journalctl to exit 0 for ${unit}, received exit ${out.code}: ${stderr.slice(0, 200)}`);
  return lastFinishAgeS(unit, new TextDecoder().decode(out.stdout), Date.now());
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
  const [search, stats, curate, seed, fence, cache, disk] = await Promise.all([
    measured(`fetching ${SEARCH_URL}`, TIMEOUT_MS, searchMs),
    measured("querying the channel table", DB_TIMEOUT_MS, () => dbStats(url)),
    measured("reading the journal for telecast-curate.service", TIMEOUT_MS, () => lastSuccessS("telecast-curate.service")),
    measured("reading the journal for telecast-seed.service", TIMEOUT_MS, () => lastSuccessS("telecast-seed.service")),
    measured(`fetching ${FENCE_URL}`, FENCE_TIMEOUT_MS, fenceProbe),
    measured("summing cache/", TIMEOUT_MS, () => cacheBytes(CACHE_DIRS)),
    measured("running df -Pk cache", TIMEOUT_MS, diskFree),
  ]);
  const m: Measurements = { search, db: stats, curate, seed, fence, cache, disk };
  // snitch parses from the first line that starts with "{", so a reason line stays on one line.
  for (const [name, r] of Object.entries(m)) if ("error" in r) console.log(`${name}: ${r.error.replace(/\s+/g, " ")}`);
  if ("ok" in stats && stats.ok.freshS === null) console.log("db: no channel has a last_success_at");
  if ("ok" in stats && stats.ok.refreshed === 0) console.log("db: no channel was refreshed in the past 24h");
  if ("ok" in fence && !fence.ok) {
    console.log(`fence: ${FENCE_URL} answered without a timeout, so the proxy may reach ${FENCE_TARGET}.`);
  }
  for (const [name, r] of [["curate", curate], ["seed", seed]] as const) {
    if ("ok" in r && r.ok === null) console.log(`${name}: no successful run of telecast-${name}.service in the journal`);
  }
  const cs = grade(m);
  console.log(
    cs.map((c, i) => `${i ? "," : "{"} ${JSON.stringify(c.name)}: { "0": ${Math.floor(c.score * 100) / 100} }`).join("\n") + "\n}",
  );
  if (cs.some((c) => c.score < 1)) Deno.exit(1);
}
