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
    const url = new URL(request.url);
    const feedId = url.searchParams.get("id");
    const since = url.searchParams.get("since");
    const max = url.searchParams.get("max");
    const enclosure = url.searchParams.get("enclosure");
    const fulltext = url.searchParams.has("fulltext");

    if (!feedId)
      return new Response("Feed ID required", { status: 400, headers });

    // Generate authentication hash
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

    // Build query parameters
    const queryParams = new URLSearchParams();
    queryParams.append("id", feedId);
    if (since) queryParams.append("since", since);
    if (max) queryParams.append("max", max);
    if (enclosure) queryParams.append("enclosure", enclosure);
    if (fulltext) queryParams.append("fulltext", "");

    const response = await fetch(
      `https://api.podcastindex.org/api/1.0/episodes/byfeedid?${queryParams}`,
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

    const { items = [] } = await response.json();
    return new Response(
      JSON.stringify(
        items.map((episode) => ({
          id: episode.id,
          title: episode.title,
          description: episode.description,
          thumbnail: episode.image || "https://placekitten.com/160/90",
          src: episode.enclosureUrl,
          duration: episode.duration,
          datePublished: episode.datePublished,
          explicit: episode.explicit,
        })),
      ),
      { headers },
    );
  } catch (error) {
    console.error("Episodes fetch error:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch episodes" }), {
      status: 500,
      headers,
    });
  }
}
