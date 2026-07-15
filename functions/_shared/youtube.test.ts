import { assert, assertEquals } from "jsr:@std/assert";
import { preferUulfFeedUrl, resolveYoutubeFeedUrl } from "./youtube.ts";

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
