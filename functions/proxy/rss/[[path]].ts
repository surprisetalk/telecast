import * as rss from "../../_shared/rss";
import db from "postgres";
import type { Env } from "../../env";
import type { Sql } from "../../search";

export interface RssProxyDeps {
  sql: Sql;
  bucket: R2Bucket;
  fetcher: typeof fetch;
}

export async function handleRssProxy(deps: RssProxyDeps, input: { rssUrl: string }): Promise<Response> {
  const { sql, bucket, fetcher } = deps;
  const { rssUrl } = input;
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
