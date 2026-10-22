import db from "postgres";
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

export function linksFromRedditListing(json: any): string[] {
  const out: string[] = [];
  for (const child of json?.data?.children ?? []) {
    const d = child?.data ?? {};
    for (const f of [d.url, d.title, d.selftext]) {
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

// --- Source adapters (network) ------------------------------------------------

async function fromHackerNews(): Promise<string[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=youtube.com&tags=(story,comment)&hitsPerPage=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HN Algolia HTTP ${res.status}`);
  const data = await res.json() as { hits?: unknown };
  if (!Array.isArray(data.hits)) throw new Error(`HN Algolia: expected hits[] array, got ${typeof data.hits}`);
  return linksFromHnHits(data.hits);
}

// Reddit asks for this User-Agent form: <platform>:<app id>:<version> (by <contact>).
const REDDIT_UA = "deno:telecast-seeder:1.1 (by telecast.company)";

// Reddit closed unauthenticated search.json, so seed takes an app-only token (OAuth client credentials) from a "script" app.
export async function fromReddit(env: (k: string) => string | undefined, fetcher: typeof fetch): Promise<string[]> {
  const id = env("REDDIT_CLIENT_ID"), secret = env("REDDIT_CLIENT_SECRET");
  if (!id || !secret) {
    throw new Error(
      `Reddit credentials are missing. Expected REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env, from https://www.reddit.com/prefs/apps (type: script). Received: REDDIT_CLIENT_ID ${
        id ? "set" : "missing"
      }, REDDIT_CLIENT_SECRET ${secret ? "set" : "missing"}.`,
    );
  }
  const tokenRes = await fetcher("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "user-agent": REDDIT_UA,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const tokenBody = await tokenRes.text();
  let token: { access_token?: unknown; token_type?: unknown } = {};
  try {
    token = JSON.parse(tokenBody);
  } catch { /* the check below reports the body */ }
  if (tokenRes.status !== 200 || typeof token.access_token !== "string" || token.token_type !== "bearer") {
    throw new Error(
      `Reddit token: expected HTTP 200 with a bearer access_token, received ${tokenRes.status}: ${
        tokenBody.slice(0, 200)
      }. Check the app's id and secret.`,
    );
  }
  const queries = ["youtube.com/channel", "youtube.com/@", "youtube channel"];
  const out: string[] = [];
  for (const q of queries) {
    const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(q)}&limit=100&type=link`;
    const res = await fetcher(url, {
      headers: { authorization: `bearer ${token.access_token}`, "user-agent": REDDIT_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Reddit HTTP ${res.status} for "${q}"`);
    out.push(...linksFromRedditListing(await res.json()));
  }
  return out;
}

// --- Seeding ------------------------------------------------------------------

type Sql = ReturnType<typeof db>;

async function seedChannel(
  sql: Sql | null,
  link: string,
  dryRun: boolean,
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

  try {
    const inserted = await sql`
      insert into channel ${sql(channel)}
      on conflict (channel_id) do nothing
      returning channel_id
    `;
    return { link, feed, channelId: channel.channel_id, status: inserted.length ? "inserted" : "exists" };
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

  if (!Deno.env.get("REDDIT_CLIENT_ID") || !Deno.env.get("REDDIT_CLIENT_SECRET")) {
    console.warn("WARNING: REDDIT_CLIENT_ID or REDDIT_CLIENT_SECRET is missing, so the reddit source will fail this run.");
  }
  console.log(`Gathering links...`);
  const all = await gather([
    ["hn", fromHackerNews],
    ["reddit", () => fromReddit((k) => Deno.env.get(k), fetch)],
    ["lectures", async () => linksFromLectures(JSON.parse(await Deno.readTextFile(new URL("./lectures.json", import.meta.url))))],
  ]);
  const unique = [...new Set(all)].slice(0, DEFAULT_LIMIT);
  console.log(`\n${all.length} raw → ${unique.length} unique channels (limit ${DEFAULT_LIMIT})\n`);

  const sql = dryRun || !databaseUrl ? null : db(databaseUrl, { max: CONCURRENCY, idle_timeout: 20, connect_timeout: 30 });
  const tally: Record<string, number> = {};
  await pool(unique, CONCURRENCY, async (link) => {
    const r = await seedChannel(sql, link, dryRun);
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
