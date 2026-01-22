import db from "postgres";
import type { Env } from "./env";

const BROKEN_THRESHOLD = 3;

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const sql = db(env.DATABASE_URL!);
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  if (!query) return new Response("Query parameter required", { status: 400 });
  const results = query.startsWith("tag:")
    ? await sql`
        select c.*
        from channel c
        where ${query.slice(4)} = any(tags)
          and consecutive_errors < ${BROKEN_THRESHOLD}
          and last_success_at is not null
        order by latest_episode_at desc nulls last
        limit 50
      `
    : await sql`
        select c.*
        from channel c
        where websearch_to_tsquery('english', ${query}) @@ to_tsvector('english', title || ' ' || coalesce(description, ''))
          and consecutive_errors < ${BROKEN_THRESHOLD}
          and last_success_at is not null
        order by latest_episode_at desc nulls last
        limit 50
      `;
  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
}
