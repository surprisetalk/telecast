import * as rss from "../../_shared/rss";
import db from "postgres";
import type { Env } from "../../env";
import type { Sql } from "../../search";

export interface RssProxyDeps {
  sql: Sql;
  bucket: R2Bucket;
  fetcher: typeof fetch;
}

async function resolveYoutubeFeedUrl(rawUrl: string, fetcher: typeof fetch): Promise<{ url: string } | { error: string }> {
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
  const id =
    html.match(/"channelId":"(UC[\w-]+)"/)?.[1] ??
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)"/)?.[1] ??
    html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]+)"/)?.[1];
  if (!id) return { error: `Could not extract channelId from ${pageUrl}; looked for "channelId":"UC...", <link rel="canonical" .../channel/UC...>, and <meta itemprop="identifier" content="UC...">` };
  return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` };
}

export async function handleRssProxy(deps: RssProxyDeps, input: { rssUrl: string }): Promise<Response> {
  const { sql, bucket, fetcher } = deps;
  const resolved = await resolveYoutubeFeedUrl(input.rssUrl, fetcher);
  if ("error" in resolved) return new Response(resolved.error, { status: 400 });
  const rssUrl = resolved.url;
  const cached = await bucket.get(rssUrl);
  if (cached) {
    return new Response(cached.body, {
      headers: { "content-type": "application/xml" },
    });
  }
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(rssUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Network error fetching ${rssUrl}: ${msg}`, { status: 502 });
  }
  if (!fetchResponse.ok) {
    return new Response(`Upstream feed fetch failed for ${rssUrl}: HTTP ${fetchResponse.status} ${fetchResponse.statusText}`, { status: 502 });
  }
  const text = await fetchResponse.text();
  if (!/<(feed|rss|RDF)[\s>]/.test(text)) {
    return new Response(`Not a valid feed at ${rssUrl}: missing <rss>, <feed>, or <RDF> root element`, { status: 400 });
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
  return new Response(text, {
    headers: { "content-type": "application/xml" },
  });
}

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  const rssUrl = decodeURIComponent(url.pathname.slice("/proxy/rss/".length));
  return handleRssProxy({ sql: db(env.DATABASE_URL!), bucket: env.BUCKET_RSS, fetcher: fetch }, { rssUrl });
}
