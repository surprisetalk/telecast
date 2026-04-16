import * as rss from "../../_shared/rss";
import db from "postgres";
import type { Env } from "../../env";
import type { Sql } from "../../search";

const CACHE_TTL_MS = 60 * 60 * 1000;

export async function resolveYoutubeFeedUrl(rawUrl: string, fetcher: typeof fetch): Promise<{ url: string } | { error: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { url: rawUrl };
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return { url: rawUrl };
  if (u.pathname.startsWith("/feeds/")) return { url: rawUrl };
  const channelMatch = u.pathname.match(/^\/channel\/(UC[\w-]+)/);
  if (channelMatch) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}` };
  const isHandle = u.pathname.startsWith("/@") || u.pathname.startsWith("/c/") || u.pathname.startsWith("/user/");
  if (!isHandle) return { url: rawUrl };
  const pageUrl = `https://www.youtube.com${u.pathname}`;
  const res = await fetcher(pageUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return { error: `Failed to resolve YouTube handle page ${pageUrl}: HTTP ${res.status} ${res.statusText}` };
  const html = await res.text();
  const patterns = [
    /"channelId":"(UC[\w-]+)"/,
    /"externalId":"(UC[\w-]+)"/,
    /"browseId":"(UC[\w-]+)"/,
    /<link rel="canonical" href="https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]+)"/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/,
    /\/channel\/(UC[\w-]+)/,
  ];
  let id: string | undefined;
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      id = m[1];
      break;
    }
  }
  if (!id) {
    const snippet = html.slice(0, 200).replace(/\s+/g, " ").trim();
    return {
      error:
        `Could not extract channelId from ${pageUrl} (HTML ${html.length} bytes). Tried 6 patterns including "channelId":"UC...", canonical link, /channel/UC... sweep. First 200 chars: ${snippet}`,
    };
  }
  return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` };
}

export async function handleRssProxy(
  deps: { sql: Sql; bucket: R2Bucket; fetcher: typeof fetch },
  input: { rssUrl: string },
): Promise<Response> {
  const { sql, bucket, fetcher } = deps;
  const rawUrl = input.rssUrl;
  const resolvedKey = `resolved:${rawUrl}`;
  const cachedResolved = await bucket.get(resolvedKey);
  let rssUrl: string;
  if (cachedResolved) {
    rssUrl = await cachedResolved.text();
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
  const cached = await bucket.get(rssUrl);
  const cachedText = cached ? await cached.text() : null;
  const cachedAge = cached?.uploaded ? Date.now() - cached.uploaded.getTime() : Infinity;
  if (cachedText && cachedAge < CACHE_TTL_MS) {
    return new Response(cachedText, { headers: { "content-type": "application/xml" } });
  }
  const stale = (): Response => new Response(cachedText!, { headers: { "content-type": "application/xml", "x-telecast-stale": "1" } });
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(rssUrl);
  } catch (err) {
    if (cachedText) return stale();
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Network error fetching ${rssUrl} (raw input: ${rawUrl}): ${msg}`, { status: 502 });
  }
  if (!fetchResponse.ok) {
    if (cachedText) return stale();
    return new Response(
      `Upstream feed fetch failed for ${rssUrl} (raw input: ${rawUrl}): HTTP ${fetchResponse.status} ${fetchResponse.statusText}`,
      { status: 502 },
    );
  }
  const text = await fetchResponse.text();
  if (!/<(feed|rss|RDF)[\s>]/.test(text)) {
    if (cachedText) return stale();
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    return new Response(
      `Not a valid feed at ${rssUrl} (raw input: ${rawUrl}): missing <rss>, <feed>, or <RDF> root element. First 200 chars: ${snippet}`,
      { status: 400 },
    );
  }
  const channel = rss.parse(text);
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
  await bucket.put(rssUrl, text);
  if (rssUrl !== rawUrl) await bucket.put(resolvedKey, rssUrl);
  return new Response(text, {
    headers: { "content-type": "application/xml" },
  });
}

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  const rssUrl = decodeURIComponent(url.pathname.slice("/proxy/rss/".length));
  return handleRssProxy({ sql: db(env.DATABASE_URL!), bucket: env.BUCKET_RSS, fetcher: fetch }, { rssUrl });
}
