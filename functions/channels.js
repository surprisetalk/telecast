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

    // Fetch podcast results
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

    const podcastResponse = await fetch(
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

    // Load YouTube channels from KV store or file
    const matchingChannels = youtubeChannels.filter(
      (c) =>
        c.title.toLowerCase().includes(query.toLowerCase()) ||
        c.description?.toLowerCase().includes(query.toLowerCase()),
    );

    if (!podcastResponse.ok)
      throw new Error(`API error: ${podcastResponse.status}`);

    const { feeds = [] } = await podcastResponse.json();

    const results = [
      ...matchingChannels.map((c) => ({
        id: c.channelId,
        title: c.title,
        description: c.description,
        thumbnail: c.thumbnail,
        type: "youtube",
        feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${c.channelId}`,
      })),
      ...feeds.map((f) => ({
        id: f.id,
        title: f.title,
        description: f.description,
        thumbnail: f.artwork || "https://placekitten.com/120/67",
        type: "podcast",
        episodes: (f.episodes || []).map((e) => ({
          id: e.id,
          title: e.title,
          thumbnail: e.image || f.artwork || "https://placekitten.com/160/90",
          src: e.enclosureUrl,
        })),
      })),
    ];

    return new Response(JSON.stringify(results), { headers });
  } catch (error) {
    console.error("Search error:", error);
    return new Response(JSON.stringify({ error: "Search failed" }), {
      status: 500,
      headers,
    });
  }
}

const youtubeChannels = [
  {
    channelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
    title: "MrBeast",
    description: "Gaming, challenges, and entertainment content",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZTpVz7i2Oa1vA1ECMhCj1nVrhD_AXb5IFYCvvbxWw=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UC8butISFwT-Wl7EV0hUK0BQ",
    title: "freeCodeCamp.org",
    description: "Learn to code for free with thousands of video tutorials",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZQj7WJi8A8cKRaBBqpQKGqKpuhWFS_fUJvvyYe_lA=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCsBjURrPoezykLs9EqgamOA",
    title: "Fireship",
    description: "High-intensity code tutorials and tech news",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZSBZO4jggGVsWf_R7of0Rf8yMWHuRpYtimnAKOKGw=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCvjgXvBlbQiydffZU7m1_aw",
    title: "The Coding Train",
    description: "Creative coding tutorials and challenges",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZQJrFlNRQaiRY4MfGqIBJ6X6YHkZOtXzNxkVz7lHA=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UClLXKYEEM8OBBx85DOa6-cg",
    title: "Marathon Training Academy",
    description: "Marathon training tips and running advice",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZQigy_4MYQ7UyiHXxV3ZpFvFUbqkF0K_q2XoWwv=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCBJycsmduvYEL83R_U4JriQ",
    title: "Marques Brownlee",
    description: "Quality tech videos, reviews and news",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZSNtPBPtBrB0sgP3lnFLFE8LNx36Zq7dZLfMPf4=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCR-DXc1voovS8nhAvccRZhg",
    title: "Jeff Nippard",
    description: "Science-based fitness and nutrition advice",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZTnL3Z_Gof1KPY1vzyeDRY3t9_yYe34NntUePUflw=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCZHmQk67mSJgfCCTn7xBfew",
    title: "Yannic Kilcher",
    description: "Machine learning research and paper reviews",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZRVtevPKMg-G956ZMEY_2yFA3jf0_sZYFbhoxGC=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCdp4_l1vZnF3Z_N8nHnFZuA",
    title: "Two Minute Papers",
    description: "AI and computer science research explained",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZRQH8XUn7uTvvvQ-QCNKHmIv51iB7gEH4IgBHfBhg=s176-c-k-c0x00ffffff-no-rj",
  },
  {
    channelId: "UCO1cgjhGzsSYb1rsB4bFe4Q",
    title: "Fun Fun Function",
    description: "JavaScript and software engineering concepts",
    thumbnail:
      "https://yt3.googleusercontent.com/ytc/AIf8zZTcwvVGiWpnWyQDen2H2Qy-lL3eK0UFhYqeGHun=s176-c-k-c0x00ffffff-no-rj",
  },
];
