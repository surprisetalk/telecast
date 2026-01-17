import db from "postgres";

export async function onRequest({ request, env }) {
  const sql = db(env.DATABASE_URL!);
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  console.log("TEST", query);
  if (!query) return new Response("Query parameter required", { status: 400 });
  const results = query.startsWith("pack:")
    ? await sql`
        select c.*
        from channel c
        where ${query.slice(5)} = any(packs)
        order by updated_at desc nulls last
        limit 50
      `
    : await sql`
        select c.*
        from channel c
        where to_tsquery(${query}) @@ to_tsvector(title || ' ' || coalesce(description, ''))
        union
        select c.*
        from episode e
        inner join channel c using (channel_id)
        where to_tsquery(${query}) @@ to_tsvector(e.title || ' ' || coalesce(e.description, ''))
        limit 50
      `;
  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
}
