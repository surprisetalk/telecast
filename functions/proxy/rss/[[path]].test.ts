import { assertEquals, assert } from "jsr:@std/assert";
import { resolveYoutubeFeedUrl, handleRssProxy } from "./[[path]].ts";
import type { Sql } from "../../search.ts";

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

Deno.test("channelId JSON wins over stray /channel/UC... in page body", async () => {
  const html = `href="/channel/UCjunk_garbage" later... "channelId":"UCgood_real_id" more`;
  const r = await resolveYoutubeFeedUrl("https://www.youtube.com/@foo", stub(html));
  assertEquals(r, { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCgood_real_id" });
});

const fakeBucket = (): R2Bucket => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.has(k) ? { body: store.get(k)!, text: () => Promise.resolve(store.get(k)!) } : null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve({}); },
  } as unknown as R2Bucket;
};

const fakeSql = (() => Promise.resolve([])) as unknown as Sql;

Deno.test("handleRssProxy end-to-end: @handle → scrape → feeds XML", async () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><link rel="alternate" href="https://www.youtube.com/channel/UCreal"/><title>ok</title><entry><id>x</id><title>t</title><link href="https://y"/><published>2026-01-01T00:00:00Z</published></entry></feed>`;
  const fetcher = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/@AtriocClips")) return Promise.resolve(new Response(`"channelId":"UCreal"`));
    if (url.includes("channel_id=UCreal")) return Promise.resolve(new Response(xml));
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  const res = await handleRssProxy(
    { sql: fakeSql, bucket: fakeBucket(), fetcher },
    { rssUrl: "https://www.youtube.com/@AtriocClips" },
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  assert(body.includes("<feed"));
});

Deno.test("handleRssProxy error body shows both raw and resolved URL on non-feed response", async () => {
  const fetcher = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
  assert(body.includes("channel_id=UCreal"), `expected resolved url in error, got: ${body}`);
  assert(body.includes("youtube is down"), `expected body snippet in error, got: ${body}`);
});
