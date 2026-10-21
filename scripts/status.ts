import db from "postgres";

const SITE = "https://telecast.company";
const REPO = "surprisetalk/telecast";
const TIMEOUT_MS = 10_000;
const DAY_S = 86_400;
const SEARCH_URL = `${SITE}/search?q=tag:featured`;
const runsUrl = (workflow: string) => `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs?status=success&per_page=1`;

type Measured<T> = { ok: T } | { error: string };

export type Measurements = {
  search: Measured<number>;
  db: Measured<{ freshS: number | null; refreshed: number; failed: number; bytes: number }>;
  curate: Measured<number | null>;
  seed: Measured<number | null>;
};

export function grade(m: Measurements): { name: string; score: number }[] {
  const db = "ok" in m.db ? m.db.ok : null;
  const age = (r: Measured<number | null>, limitS: number) => "ok" in r && r.ok !== null ? limitS / Math.max(r.ok, 1) : 0;
  return [
    { name: "/search?q=tag:featured answers 200 within 2 s.", score: "ok" in m.search ? 2000 / Math.max(m.search.ok, 1) : 0 },
    { name: "A feed refreshed in the past 15 min.", score: db?.freshS != null ? 900 / Math.max(db.freshS, 1) : 0 },
    {
      name: "At most 20% of channels refreshed in the past 24h failed.",
      score: db && db.refreshed > 0 ? (1 - db.failed / db.refreshed) / 0.8 : 0,
    },
    { name: "Curate succeeded in the past 2 days.", score: age(m.curate, 2 * DAY_S) },
    { name: "Seed succeeded in the past 8 days.", score: age(m.seed, 8 * DAY_S) },
    { name: "The database is smaller than 50 GB.", score: db ? 50e9 / db.bytes : 0 },
  ];
}

async function measured<T>(what: string, f: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { ok: await f() };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError"
      ? `Timed out after ${TIMEOUT_MS} ms ${what}`
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
  await res.body?.cancel();
  if (res.status !== 200) throw new Error(`Expected HTTP 200 from ${url}, received ${res.status} ${res.statusText}.`);
  return performance.now() - t0;
}

// Unauthenticated GitHub API: 60 requests/h per IP. The repo is public.
async function lastSuccessS(workflow: string): Promise<number | null> {
  const url = runsUrl(workflow);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`Expected HTTP 200 from ${url}, received ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  }
  const json: { workflow_runs?: { created_at?: unknown }[] } | null = await res.json();
  const runs = json?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`Expected {workflow_runs: [...]} from ${url}, received ${JSON.stringify(json).slice(0, 200)}`);
  if (runs.length === 0) return null;
  const at = Date.parse(String(runs[0]?.created_at));
  if (Number.isNaN(at)) {
    throw new Error(`Expected an ISO created_at in the first run from ${url}, received ${JSON.stringify(runs[0]?.created_at)}`);
  }
  return (Date.now() - at) / 1000;
}

async function dbStats(url: string) {
  const sql = db(url, { max: 1, idle_timeout: 5, connect_timeout: 30, connection: { statement_timeout: 120_000 } });
  try {
    const [r] = await sql<{ fresh_s: unknown; refreshed: unknown; failed: unknown; bytes: unknown }[]>`
      select
        extract(epoch from now() - max(last_success_at))::float8 as fresh_s,
        count(*) filter (where greatest(last_success_at, last_error_at) > now() - interval '24 hours')::int as refreshed,
        count(*) filter (
          where last_error_at > now() - interval '24 hours' and last_error_at > coalesce(last_success_at, '-infinity')
        )::int as failed,
        pg_database_size(current_database())::float8 as bytes
      from channel
    `;
    if (
      !r || !(r.fresh_s === null || typeof r.fresh_s === "number") || typeof r.refreshed !== "number" || typeof r.failed !== "number" ||
      typeof r.bytes !== "number"
    ) {
      throw new Error(`Expected one row {fresh_s, refreshed, failed, bytes} of numbers, received ${JSON.stringify(r)}`);
    }
    return { freshS: r.fresh_s as number | null, refreshed: r.refreshed as number, failed: r.failed as number, bytes: r.bytes as number };
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error(
      "DATABASE_URL is missing. Expected a postgres URL in .env. Received undefined. Copy it from the Neon console into .env.",
    );
  }
  const [search, stats, curate, seed] = await Promise.all([
    measured(`fetching ${SEARCH_URL}`, searchMs),
    measured("querying the channel table", () => dbStats(url)),
    measured(`fetching ${runsUrl("curate.yml")}`, () => lastSuccessS("curate.yml")),
    measured(`fetching ${runsUrl("seed.yml")}`, () => lastSuccessS("seed.yml")),
  ]);
  const m: Measurements = { search, db: stats, curate, seed };
  for (const [name, r] of Object.entries(m)) if ("error" in r) console.log(`${name}: ${r.error}`);
  for (const [name, r] of [["curate", curate], ["seed", seed]] as const) {
    if ("ok" in r && r.ok === null) console.log(`${name}: no successful run on GitHub Actions`);
  }
  const cs = grade(m);
  console.log(
    cs.map((c, i) => `${i ? "," : "{"} ${JSON.stringify(c.name)}: { "0": ${Math.floor(c.score * 100) / 100} }`).join("\n") + "\n}",
  );
  if (cs.some((c) => c.score < 1)) Deno.exit(1);
}
