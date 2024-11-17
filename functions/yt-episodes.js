export async function onRequest({ request, env }) {
  const headers = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGINS || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers });

  try {
    const query = new URL(request.url).searchParams.get("q");
    if (!query)
      return new Response("Search query required", { status: 400, headers });

    const time = Math.floor(Date.now() / 1000);
    const hash = await crypto.subtle
      .digest(
        "SHA-1",
        new TextEncoder().encode(env.PI_KEY + env.PI_SECRET + time),
      )
      .then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );

    const response = await fetch(
      `https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "X-Auth-Date": time.toString(),
          "X-Auth-Key": env.PI_KEY,
          Authorization: hash,
          "User-Agent": "Telecast/1.0",
        },
      },
    );

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const { feeds = [] } = await response.json();
    return new Response(
      JSON.stringify(
        feeds.map((f) => ({
          id: f.id,
          title: f.title,
          thumbnail: f.artwork || "https://placekitten.com/120/67",
          episodes: (f.episodes || []).map((e) => ({
            id: e.id,
            title: e.title,
            thumbnail: e.image || f.artwork || "https://placekitten.com/160/90",
            src: e.enclosureUrl,
          })),
        })),
      ),
      { headers },
    );
  } catch (error) {
    console.error("Search error:", error);
    return new Response(JSON.stringify({ error: "Search failed" }), {
      status: 500,
      headers,
    });
  }
}
