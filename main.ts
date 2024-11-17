import { HTTPException } from "jsr:@hono/hono/http-exception";
import { Hono, Context } from "jsr:@hono/hono";
import { some, every, except } from "jsr:@hono/hono/combine";
import { createMiddleware } from "jsr:@hono/hono/factory";
import { logger } from "jsr:@hono/hono/logger";
import { prettyJSON } from "jsr:@hono/hono/pretty-json";
import { basicAuth } from "jsr:@hono/hono/basic-auth";
import { html } from "jsr:@hono/hono/html";
import { cors } from "jsr:@hono/hono/cors";
import {
  getSignedCookie,
  setSignedCookie,
  deleteCookie,
} from "jsr:@hono/hono/cookie";
import { serveStatic } from "jsr:@hono/hono/deno";

const PI_KEY = "TWTGLQDR8H7LKHYUURNT";
const PI_SECRET = "QKVK$k2TSSae9vRyCHqV9sKj^$tUP2bpHekd2CKf";

const app = new Hono();

app.use("/*", cors());

// https://yt3.googleusercontent.com/ytc/UC9-y-6csu5WGm29I7JiwpnA

const youtubeChannels = [
  {
    title: "TED",
    thumbnail: "/yt.png",
    rss: "https://www.youtube.com/feeds/videos.xml?channel_id=UCAuUUnT6oDeKwE6v1NGQxug",
  },
  {
    title: "Computerphile",
    thumbnail: "/yt.png",
    rss: "https://www.youtube.com/feeds/videos.xml?channel_id=UC9-y-6csu5WGm29I7JiwpnA",
  },
];

async function fetchPodcasts(query: string) {
  try {
    const time = Math.floor(Date.now() / 1000);
    const hash = await crypto.subtle
      .digest("SHA-1", new TextEncoder().encode(PI_KEY + PI_SECRET + time))
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
          "X-Auth-Key": PI_KEY,
          Authorization: hash,
          "User-Agent": "Telecast/1.0",
        },
      },
    );

    const data = await response.json();

    // Transform podcast results to match our channel format
    return data.feeds.map((feed: any) => ({
      title: feed.title,
      thumbnail: feed.artwork || "default-thumbnail.jpg",
      rss: feed.url,
    }));
  } catch (error) {
    console.error("Error fetching podcasts:", error);
    return [];
  }
}

app.get("/proxy/rss", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "URL parameter is required" }, 400);
  const response = await fetch(url);
  const text = await response.text();
  return new Response(text, {
    headers: {
      "Content-Type": "application/xml",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

app.get("/channels", async (c) => {
  const query = c.req.query("q")?.toLowerCase() || "";
  return c.json([
    ...youtubeChannels.filter((channel) =>
      channel.title.toLowerCase().includes(query),
    ),
    ...(await fetchPodcasts(query)),
  ]);
});

// app.get("/*", async (c) => {
//   try {
//     const path = c.req.path === "/" ? "/index.html" : c.req.path;
//     const file = await Deno.readFile(`./public${path}`);
//     const extension = path.split(".").pop();
//
//     const mimeTypes: Record<string, string> = {
//       html: "text/html",
//       css: "text/css",
//       js: "application/javascript",
//     };
//
//     return new Response(file, {
//       headers: {
//         "Content-Type":
//           mimeTypes[extension || ""] || "application/octet-stream",
//       },
//     });
//   } catch {
//     return c.notFound();
//   }
// });

app.use("/*", serveStatic({ root: "./public" }));

// Deno.serve(
//   {
//     hostname: Deno.env.get("HOST") ?? "0.0.0.0",
//     port: parseInt(Deno.env.get("PORT") ?? "") || 8080,
//   },
//   app.fetch,
// );

export default app;
