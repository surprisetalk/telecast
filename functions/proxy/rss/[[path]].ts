import * as rss from "../../_shared/rss.ts";
import type { Cache } from "../../_shared/cache.ts";
import { readCapped } from "../../_shared/body.ts";
import type { Sql } from "../../search.ts";
import { resolveYoutubeFeedUrl } from "../../_shared/youtube.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_MB = 50;

export async function handleRssProxy(
  deps: { sql: Sql; cache: Cache; fetcher: typeof fetch },
  input: { rssUrl: string },
): Promise<Response> {
  const { sql, cache, fetcher } = deps;
  const rawUrl = input.rssUrl;
  const resolvedKey = `resolved2:${rawUrl}`;
  const cachedResolved = await cache.get(resolvedKey);
  let rssUrl: string;
  if (cachedResolved) {
    rssUrl = new TextDecoder().decode(cachedResolved.bytes);
  } else {
    let resolved: { url: string } | { error: string };
    try {
      resolved = await resolveYoutubeFeedUrl(rawUrl, fetcher);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Resolver threw for ${rawUrl}: ${msg}`, { status: 502 });
    }
    if ("error" in resolved) return new Response(resolved.error, { status: 400 });
    rssUrl = resolved.url;
  }
  const cached = await cache.get(rssUrl);
  const cachedText = cached ? new TextDecoder().decode(cached.bytes) : null;
  const cachedAge = cached ? Date.now() - cached.at.getTime() : Infinity;
  if (cachedText && cachedAge < CACHE_TTL_MS) {
    return new Response(cachedText, { headers: { "content-type": "application/xml" } });
  }
  const stale = (reason: string): Response => {
    console.error(`rss proxy: serving stale ${rssUrl}: ${reason}`);
    return new Response(cachedText!, { headers: { "content-type": "application/xml", "x-telecast-stale": "1" } });
  };
  const networkError = (err: unknown): Response => {
    const msg = err instanceof DOMException && err.name === "TimeoutError"
      ? `Timed out after ${FETCH_TIMEOUT_MS} ms fetching ${rssUrl}`
      : err instanceof Error
      ? err.message
      : String(err);
    if (cachedText) return stale(msg);
    return new Response(`Network error fetching ${rssUrl} (raw input: ${rawUrl}): ${msg}`, { status: 502 });
  };
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(rssUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return networkError(err);
  }
  if (!fetchResponse.ok) {
    const status = `HTTP ${fetchResponse.status} ${fetchResponse.statusText}`.trim();
    if (cachedText) return stale(status);
    return new Response(`Upstream feed fetch failed for ${rssUrl} (raw input: ${rawUrl}): ${status}`, { status: 502 });
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(fetchResponse, MAX_MB * 1e6);
  } catch (err) {
    return networkError(err);
  }
  if (!bytes) {
    const tooBig = `Feed at ${rssUrl} is larger than ${MAX_MB} MB. Expected a feed under ${MAX_MB} MB.`;
    if (cachedText) return stale(tooBig);
    return new Response(tooBig, { status: 502 });
  }
  const text = new TextDecoder().decode(bytes);
  if (!/<(feed|rss|RDF)[\s>]/.test(text)) {
    if (cachedText) return stale("missing <rss>, <feed>, or <RDF> root element");
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    return new Response(
      `Not a valid feed at ${rssUrl} (raw input: ${rawUrl}): missing <rss>, <feed>, or <RDF> root element. First 200 chars: ${snippet}`,
      { status: 400 },
    );
  }
  const channel = rss.parse(text, rssUrl);
  await sql`
    insert into channel ${sql(channel)}
    on conflict (channel_id) do update
    set
      title = excluded.title,
      description = excluded.description,
      thumb = excluded.thumb,
      tags = CASE
        WHEN excluded.tags IS NOT NULL
        THEN (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(channel.tags, '{}') || excluded.tags) AS t)
        ELSE channel.tags
      END
  `;
  await cache.put(rssUrl, text);
  if (rssUrl !== rawUrl) await cache.put(resolvedKey, rssUrl);
  return new Response(text, {
    headers: { "content-type": "application/xml" },
  });
}
