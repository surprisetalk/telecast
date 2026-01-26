import db from "postgres";
import type { Env } from "./env";

const QUALITY_THRESHOLD = 10;

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const sql = db(env.DATABASE_URL!);
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  if (!query) return new Response("Query parameter required", { status: 400 });
  // Shorts filtering: prefer non-Shorts thumbnails, fall back to any if all are Shorts
  const episodeThumbSubquery = sql`
    coalesce(
      (select thumb from episode e
       where e.channel_id = c.channel_id
         and e.thumb is not null
         and not (
           lower(title) like '%#shorts%'
           or lower(title) like '%#short%'
           or lower(coalesce(description, '')) like '%#shorts%'
         )
       order by published_at desc nulls last
       limit 1),
      (select thumb from episode e
       where e.channel_id = c.channel_id
         and e.thumb is not null
       order by published_at desc nulls last
       limit 1)
    )`;

  const results = query.startsWith("tag:")
    ? await sql`
        select c.*, ${episodeThumbSubquery} as episode_thumb
        from channel c
        where ${query.slice(4)} = any(tags)
          and quality >= ${QUALITY_THRESHOLD}
        order by quality desc
        limit 50
      `
    : await sql`
        select c.*, ${episodeThumbSubquery} as episode_thumb
        from channel c
        where websearch_to_tsquery('english', ${query}) @@ to_tsvector('english', title || ' ' || coalesce(description, ''))
          and quality >= ${QUALITY_THRESHOLD}
        order by quality desc
        limit 50
      `;
  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
}
