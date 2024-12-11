import * as rss from "../../_shared/rss";
import db from "postgres";

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const rssUrl = decodeURIComponent(url.pathname.slice("/proxy/rss/".length));
  let response = await env.BUCKET_RSS.get(rssUrl);
  if (!response) {
    const sql = db(env.DATABASE_URL!);
    response = await fetch(rssUrl);
    const text = await response.clone().text();
    if (!/<(feed|rss|RDF)[\s>]/.test(text)) return new Response("Invalid RSS feed", { status: 400 });
    const channel = rss.parse(text);
    await sql`
      insert into channel ${sql(channel)}
      on conflict (channel_id) do update
      set 
        title = excluded.title,
        description = excluded.description,
        thumb = excluded.thumb,
        updated_at = now()
    `;
    await env.BUCKET_RSS.put(rssUrl, text);
  }
  return new Response(response.body, {
    headers: response.headers,
  });
}
