import { assert, assertEquals } from "jsr:@std/assert";
import { handleRssProxy } from "./[[path]].ts";
import type { Sql } from "../../search.ts";

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
