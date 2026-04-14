import db from "postgres";
import type { Env } from "./env";

const QUALITY_THRESHOLD = 10;
const TRIGRAM_THRESHOLD = 0.3;

export type Sql = ReturnType<typeof db>;

function parseQuery(raw: string): { tags: string[]; text: string } {
  const tags: string[] = [];
  const rest: string[] = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("tag:")) {
      const t = tok.slice(4).toLowerCase();
      if (t) tags.push(t);
    } else rest.push(tok);
  }
  return { tags, text: rest.join(" ").trim() };
}

export async function handleSearch(deps: { sql: Sql }, input: { query: string | null }): Promise<Response> {
  const { sql } = deps;
  const { query } = input;
  if (!query) return new Response("Missing required query parameter: 'q'. Example: /search?q=rust", { status: 400 });

  const { tags, text } = parseQuery(query);
  if (tags.length === 0 && !text) return new Response("Empty query", { status: 400 });

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

  try {
    const results = tags.length > 0 && !text
      ? await sql`
          select c.*, ${episodeThumbSubquery} as episode_thumb
          from channel c
          where c.tags @> ${tags}::text[]
            and c.quality >= ${QUALITY_THRESHOLD}
          order by c.quality desc
          limit 50
        `
      : await sql`
          select c.*, ${episodeThumbSubquery} as episode_thumb,
            (
              0.6 * ts_rank_cd(
                to_tsvector('english', c.title || ' ' || coalesce(c.description, '')) ||
                  coalesce(c.keywords, ''::tsvector),
                websearch_to_tsquery('english', ${text})
              )
              + 0.3 * similarity(lower(c.title), ${text.toLowerCase()})
              + 0.1 * (c.quality::float / 100.0)
            ) as score
          from channel c
          where c.quality >= ${QUALITY_THRESHOLD}
            ${tags.length > 0 ? sql`and c.tags @> ${tags}::text[]` : sql``}
            and (
              websearch_to_tsquery('english', ${text}) @@ (
                to_tsvector('english', c.title || ' ' || coalesce(c.description, '')) ||
                  coalesce(c.keywords, ''::tsvector)
              )
              or similarity(lower(c.title), ${text.toLowerCase()}) > ${TRIGRAM_THRESHOLD}
            )
          order by score desc
          limit 50
        `;
    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Search query failed for q="${query}": ${message}`);
    return new Response(`Search failed: ${message}`, { status: 502 });
  }
}

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  return handleSearch({ sql: db(env.DATABASE_URL!) }, { query: url.searchParams.get("q") });
}
