import { assertEquals, assert } from "jsr:@std/assert";
import { resolveYoutubeFeedUrl } from "./[[path]].ts";

const stub = (body: string, ok = true): typeof fetch =>
  ((_input: RequestInfo | URL) => Promise.resolve(new Response(body, { status: ok ? 200 : 500 }))) as typeof fetch;

Deno.test("direct /channel/UC... short-circuits without fetching", async () => {
  let fetched = false;
  const f = ((_: RequestInfo | URL) => {
    fetched = true;
    return Promise.resolve(new Response(""));
  }) as typeof fetch;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg", f);
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg" });
  assertEquals(fetched, false);
});

Deno.test("@handle resolves via canonical link", async () => {
  const html = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg"></head></html>`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@AtriocClips", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg" });
});

Deno.test("@handle resolves via channelId JSON", async () => {
  const html = `garbage "channelId":"UCabc_def-123" garbage`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@foo", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc_def-123" });
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

Deno.test("already a feeds/videos.xml URL passes through", async () => {
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCdBXOyqr8cDshsp7kcKDAkg";
  const r = await resolveYoutubeFeedUrl(url, stub(""));
  assertEquals(r, { url });
});
