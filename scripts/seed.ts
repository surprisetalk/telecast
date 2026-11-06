import db from "postgres";
import { readCapped } from "../functions/_shared/body.ts";
import { parse } from "../functions/_shared/rss.ts";
import { resolveYoutubeFeedUrl } from "../functions/_shared/youtube.ts";
import { pool } from "./pool.ts";

const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 10;
const DEFAULT_LIMIT = 300;

// --- Pure extraction (unit-tested) --------------------------------------------

const YT_LINK_RE = /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:channel\/UC[\w-]+|@[\w.-]+|c\/[\w%.-]+|user\/[\w-]+)/gi;

export function extractYoutubeLinks(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(YT_LINK_RE)) {
    const url = m[0]
      .replace(/[.,)\]]+$/, "")
      .replace(/^https?:\/\/(?:www\.|m\.)?youtube\.com/i, "https://www.youtube.com");
    out.add(url);
  }
  return [...out];
}

export function linksFromHnHits(hits: unknown): string[] {
  const out: string[] = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    for (const f of [hit?.url, hit?.title, hit?.story_text, hit?.comment_text]) {
      if (typeof f === "string") out.push(...extractYoutubeLinks(f));
    }
  }
  return out;
}

// Lectures are a curated, trusted list — take any http(s) URL verbatim
// (YouTube channels get UULF-resolved later; other feeds pass through).
export function linksFromLectures(json: unknown): string[] {
  return (Array.isArray(json) ? json : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim()))
    .map((u) => u.trim());
}

// Dataset: github.com/chen-zhitao/Youtube-Channels-Dataset, data/channels.csv, about 16k popular channels.
// License: the repo has none, so every right stays with the author. Seed reads only the channel ids, which are facts, and never stores the
// descriptions. Pinned to a commit so a rewrite of the repo cannot change what seed parses.
const GITHUB_URL =
  "https://raw.githubusercontent.com/chen-zhitao/Youtube-Channels-Dataset/074958789b814f2d59612542bf3f9b75d9c811a1/data/channels.csv";
export const GITHUB_MAX_BYTES = 120_000_000; // the file is 92 MB
// REVIEW: Sample 100 random dataset channels per run, inside the run's DEFAULT_LIMIT of 300 links. Each link costs a resolve and a feed
// fetch. Alternative: take the whole dataset (16k rows) in one run. It costs 16k fetches, past the seed unit's 1 h timeout.
export const GITHUB_PER_RUN = 100;

// Rows look like `UC<22 chars>,https://www.youtube.com/channel/UC<same>,description`. A description may span lines, so match the row start.
export function linksFromGithubCsv(csv: string): string[] {
  return [...csv.matchAll(/^(UC[\w-]{22}),https:\/\/www\.youtube\.com\/channel\/\1,/gm)].map((m) =>
    `https://www.youtube.com/channel/${m[1]}`
  );
}

// Index feeds, not files: seed adds one channel per collection, and refresh reads the newest 50 items.
// Fixed list: old-time radio, public-domain film, and Berkeley lecture webcasts.
const ARCHIVE_COLLECTIONS = ["oldtimeradio", "prelinger", "ucberkeley-webcast"];

export function archiveFeedUrls(): string[] {
  return ARCHIVE_COLLECTIONS.map((c) => `https://archive.org/services/collection-rss.php?collection=${c}`);
}

// --- Source adapters (network) ------------------------------------------------

async function fromHackerNews(): Promise<string[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=youtube.com&tags=(story,comment)&hitsPerPage=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HN Algolia HTTP ${res.status}`);
  const data = await res.json() as { hits?: unknown };
  if (!Array.isArray(data.hits)) throw new Error(`HN Algolia: expected hits[] array, got ${typeof data.hits}`);
  return linksFromHnHits(data.hits);
}

export async function fromGithub(fetcher: typeof fetch): Promise<string[]> {
  const res = await fetcher(GITHUB_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GitHub dataset HTTP ${res.status} for ${GITHUB_URL}`);
  const body = await readCapped(res, GITHUB_MAX_BYTES);
  if (!body) throw new Error(`GitHub dataset: expected at most ${GITHUB_MAX_BYTES} bytes, received more from ${GITHUB_URL}`);
  const all = linksFromGithubCsv(new TextDecoder().decode(body));
  // Partial Fisher-Yates: only the first GITHUB_PER_RUN slots get shuffled.
  for (let i = 0; i < Math.min(GITHUB_PER_RUN, all.length); i++) {
    const j = i + Math.floor(Math.random() * (all.length - i));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, GITHUB_PER_RUN);
}

// --- Seeding ------------------------------------------------------------------

type Sql = ReturnType<typeof db>;

export async function seedChannel(
  sql: Sql | null,
  link: string,
  dryRun: boolean,
  tags: string[],
): Promise<{ link: string; feed?: string; channelId?: string; status: string }> {
  let resolved: { url: string } | { error: string };
  try {
    resolved = await resolveYoutubeFeedUrl(link, fetch);
  } catch (e) {
    return { link, status: `resolve-threw: ${(e as Error).message}` };
  }
  if ("error" in resolved) return { link, status: `resolve-error: ${resolved.error.slice(0, 80)}` };
  const feed = resolved.url;
  if (dryRun || !sql) return { link, feed, status: "dry-run" };

  let text: string;
  try {
    const res = await fetch(feed, { headers: { "user-agent": "Telecasts/1.0" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { link, feed, status: `feed HTTP ${res.status}` };
    text = await res.text();
  } catch (e) {
    return { link, feed, status: `feed-fetch: ${(e as Error).message}` };
  }

  let channel;
  try {
    channel = parse(text, feed);
  } catch (e) {
    return { link, feed, status: `parse: ${(e as Error).message}` };
  }
  if (!channel.title) return { link, feed, channelId: channel.channel_id, status: "no-title-skip" };
  if (!channel.rss || !/^https:\/\//i.test(channel.rss)) {
    return { link, feed, channelId: channel.channel_id, status: "no-rss-skip" };
  }

  // parse() sets rss to the page link, but refresh must fetch the feed.
  channel.rss = feed;
  const merged = [...new Set([...(channel.tags ?? []), ...tags])];
  channel.tags = merged.length ? merged : null;

  try {
    // A channel seeded earlier gains new tags. The where clause skips the write when it has them all or there are none.
    const rows = await sql`
      insert into channel ${sql(channel)}
      on conflict (channel_id) do update
        set tags = (select array_agg(distinct t order by t) from unnest(coalesce(channel.tags, '{}') || excluded.tags) t)
        where not coalesce(channel.tags, '{}') @> excluded.tags
      returning xmax = 0 as inserted
    `;
    return { link, feed, channelId: channel.channel_id, status: rows[0]?.inserted ? "inserted" : "exists" };
  } catch (e) {
    return { link, feed, channelId: channel.channel_id, status: `insert-error: ${(e as Error).message}` };
  }
}

// --- CLI ----------------------------------------------------------------------

function parseArgs(args: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${a}. The only accepted flag is --dry-run`);
  }
  return { dryRun };
}

export async function gather(sources: [string, () => Promise<string[]>][]): Promise<string[]> {
  const links: string[] = [];
  const dead: string[] = [];
  for (const [name, load] of sources) {
    try {
      const found = await load();
      console.log(`  ${name}: ${found.length} links`);
      if (found.length === 0) console.warn(`  WARNING: ${name} returned 0 links (schema drift, rate-limit, or block?)`);
      links.push(...found);
    } catch (e) {
      dead.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (dead.length) {
    throw new Error(
      `Seed sources failed: ${dead.join("; ")}. Expected every source to load. ` +
        `Fix the adapter in scripts/seed.ts or scripts/lectures.json, or rerun later for a rate limit.`,
    );
  }
  return links;
}

async function main() {
  const { dryRun } = parseArgs(Deno.args);
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl && !dryRun) {
    console.error("DATABASE_URL not set (use --dry-run to preview without a DB)");
    Deno.exit(1);
  }

  console.log(`Gathering links...`);
  const lectures = new Set<string>();
  // Curated sources come first, so the global limit never drops them.
  const all = await gather([
    ["lectures", async () => {
      const links = linksFromLectures(JSON.parse(await Deno.readTextFile(new URL("./lectures.json", import.meta.url))));
      links.forEach((l) => lectures.add(l));
      return links;
    }],
    ["archive", () => Promise.resolve(archiveFeedUrls())],
    ["github", () => fromGithub(fetch)],
    ["hn", fromHackerNews],
  ]);
  const unique = [...new Set(all)].slice(0, DEFAULT_LIMIT);
  console.log(`\n${all.length} raw → ${unique.length} unique channels (limit ${DEFAULT_LIMIT})\n`);

  const sql = dryRun || !databaseUrl ? null : db(databaseUrl, { max: CONCURRENCY, idle_timeout: 20, connect_timeout: 30 });
  const tally: Record<string, number> = {};
  await pool(unique, CONCURRENCY, async (link) => {
    const r = await seedChannel(sql, link, dryRun, lectures.has(link) ? ["lectures"] : []);
    tally[r.status.split(":")[0]!] = (tally[r.status.split(":")[0]!] ?? 0) + 1;
    console.log(`  [${r.status}] ${r.link}${r.feed && r.feed !== r.link ? ` → ${r.feed}` : ""}`);
  });

  console.log(`\nDone: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (sql) await sql.end();

  if (unique.length === 0) {
    console.error("No channels discovered from any source (adapters all empty — schema drift, rate-limit, or network block?).");
    Deno.exit(1);
  }
  if (!dryRun && (tally["inserted"] ?? 0) + (tally["exists"] ?? 0) === 0) {
    console.error("Processed channels but none reached the DB (every insert failed — check DATABASE_URL / connectivity).");
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
}
