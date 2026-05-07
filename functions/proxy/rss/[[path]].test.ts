import { assert, assertEquals } from "jsr:@std/assert";
import { handleRssProxy, preferUulfFeedUrl, resolveYoutubeFeedUrl } from "./[[path]].ts";
import type { Sql } from "../../search.ts";

// Fetcher that responds 200 to any HEAD probe (so UULF probes succeed),
// and returns `body` for GETs.
const stub = (body: string, ok = true): typeof fetch =>
  ((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.resolve(new Response(body, { status: ok ? 200 : 500 }));
  }) as typeof fetch;

// HEAD probe always 404s — exercises the UULF-fallback path.
const stubNoUulf = (body: string): typeof fetch =>
  ((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(body));
  }) as typeof fetch;

Deno.test("preferUulfFeedUrl: UULF 200 → returns playlist_id URL", async () => {
  const url = await preferUulfFeedUrl("UCdBXOyqr8cDshsp7kcKDAkg", stub(""));
  assertEquals(url, "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFdBXOyqr8cDshsp7kcKDAkg");
});

Deno.test("preferUulfFeedUrl: UULF 404 → falls back to channel_id URL", async () => {
  const url = await preferUulfFeedUrl("UCdBXOyqr8cDshsp7kcKDAkg", stubNoUulf(""));
  assertEquals(url, "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg");
});

Deno.test("preferUulfFeedUrl: probe throws → falls back to channel_id URL", async () => {
  const f = ((_: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") return Promise.reject(new Error("network down"));
    return Promise.resolve(new Response(""));
  }) as typeof fetch;
  const url = await preferUulfFeedUrl("UCabc", f);
  assertEquals(url, "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc");
});

Deno.test("direct /channel/UC... probes UULF and returns playlist_id form", async () => {
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg", stub(""));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFdBXOyqr8cDshsp7kcKDAkg" });
});

Deno.test("direct /channel/UC... falls back to channel_id when UULF 404s", async () => {
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg", stubNoUulf(""));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg" });
});

Deno.test("@handle resolves via canonical link, prefers UULF", async () => {
  const html = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg"></head></html>`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@AtriocClips", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFdBXOyqr8cDshsp7kcKDAkg" });
});

Deno.test("@handle resolves via channelId JSON, prefers UULF", async () => {
  const html = `garbage "channelId":"UCabc_def-123" garbage`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@foo", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFabc_def-123" });
});

Deno.test("@handle with no UC... anywhere returns detailed error", async () => {
  const html = `<html><body>consent wall, please log in</body></html>`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@foo", stub(html));
  assert("error" in r);
  assert(r.error.includes("https://www.youtube.com/@foo"));
  assert(r.error.includes("consent wall"));
});

Deno.test("non-youtube URL passes through", async () => {
  const r = await resolveYoutubeFeedUrl("https://example.com/feed.xml", stub(""));
  assertEquals(r, { url: "https://example.com/feed.xml" });
});

Deno.test("/feeds/ URL with channel_id=UC... gets rewritten to playlist_id=UULF...", async () => {
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg";
  const r = await resolveYoutubeFeedUrl(url, stub(""));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFdBXOyqr8cDshsp7kcKDAkg" });
});

Deno.test("/feeds/ URL with channel_id=UC... falls back to original on UULF 404", async () => {
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg";
  const r = await resolveYoutubeFeedUrl(url, stubNoUulf(""));
  assertEquals(r, { url });
});

Deno.test("/feeds/ URL with playlist_id=UULF... passes through", async () => {
  const url = "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFdBXOyqr8cDshsp7kcKDAkg";
  const r = await resolveYoutubeFeedUrl(url, stub(""));
  assertEquals(r, { url });
});

Deno.test("channelId JSON wins over stray /channel/UC... in page body", async () => {
  const html = `href="/channel/UCjunk_garbage" later... "channelId":"UCgood_real_id" more`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@foo", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFgood_real_id" });
});

const fakeBucket = (seed: Record<string, { text: string; uploaded?: Date }> = {}): R2Bucket => {
  const store = new Map<string, { text: string; uploaded: Date }>(
    Object.entries(seed).map(([k, v]) => [k, { text: v.text, uploaded: v.uploaded ?? new Date() }]),
  );
  return {
    get: (k: string) =>
      Promise.resolve(
        store.has(k)
          ? { body: store.get(k)!.text, uploaded: store.get(k)!.uploaded, text: () => Promise.resolve(store.get(k)!.text) }
          : null,
      ),
    put: (k: string, v: string) => {
      store.set(k, { text: v, uploaded: new Date() });
      return Promise.resolve({});
    },
  } as unknown as R2Bucket;
};

const fakeSql = (() => Promise.resolve([])) as unknown as Sql;

Deno.test("handleRssProxy end-to-end: @handle → scrape → UULF feed XML", async () => {
  const xml =
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:playlistId>UULFreal</yt:playlistId><title>ok</title><entry><id>x</id><title>t</title><link href="https://y"/><published>2026-01-01T00:00:00Z</published><yt:channelId>UCreal</yt:channelId></entry></feed>`;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.includes("/@AtriocClips")) return Promise.resolve(new Response(`"channelId":"UCreal"`));
    if (url.includes("playlist_id=UULFreal")) return Promise.resolve(new Response(xml));
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket(), fetcher },
    { rssUrl: "https://www.youtube.com/@AtriocClips" },
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  assert(body.includes("<yt:playlistId>UULFreal"));
});

Deno.test("handleRssProxy: fresh cache hit skips origin fetch", async () => {
  const url = "https://example.com/feed.xml";
  const xml = `<?xml version="1.0"?><rss><channel><title>cached</title></channel></rss>`;
  let fetched = false;
  const fetcher = ((_: RequestInfo | URL) => {
    fetched = true;
    return Promise.resolve(new Response(""));
  }) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket({ [url]: { text: xml } }), fetcher },
    { rssUrl: url },
  );
  assertEquals(res.status, 200);
  assertEquals(fetched, false);
  assertEquals(res.headers.get("x-telecast-stale"), null);
  assertEquals(await res.text(), xml);
});

Deno.test("handleRssProxy: expired cache triggers refetch", async () => {
  const url = "https://example.com/feed.xml";
  const oldXml = `<?xml version="1.0"?><rss><channel><title>old</title></channel></rss>`;
  const newXml = `<?xml version="1.0"?><rss><channel><title>new</title></channel></rss>`;
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const fetcher = ((_: RequestInfo | URL) => Promise.resolve(new Response(newXml))) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket({ [url]: { text: oldXml, uploaded: twoHoursAgo } }), fetcher },
    { rssUrl: url },
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-telecast-stale"), null);
  assertEquals(await res.text(), newXml);
});

Deno.test("handleRssProxy: expired cache + origin failure serves stale", async () => {
  const url = "https://example.com/feed.xml";
  const oldXml = `<?xml version="1.0"?><rss><channel><title>old</title></channel></rss>`;
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const fetcher = ((_: RequestInfo | URL) => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket({ [url]: { text: oldXml, uploaded: twoHoursAgo } }), fetcher },
    { rssUrl: url },
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-telecast-stale"), "1");
  assertEquals(await res.text(), oldXml);
});

Deno.test("handleRssProxy error body shows both raw and resolved URL on non-feed response", async () => {
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.includes("/@AtriocClips")) return Promise.resolve(new Response(`"channelId":"UCreal"`));
    return Promise.resolve(new Response("<html>youtube is down</html>"));
  }) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket(), fetcher },
    { rssUrl: "https://www.youtube.com/@AtriocClips" },
  );
  assertEquals(res.status, 400);
  const body = await res.text();
  assert(body.includes("@AtriocClips"), `expected raw input in error, got: ${body}`);
  assert(body.includes("playlist_id=UULFreal"), `expected resolved url in error, got: ${body}`);
  assert(body.includes("youtube is down"), `expected body snippet in error, got: ${body}`);
});
