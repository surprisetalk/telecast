// Integration tests for Telecast backend (parser + worker handlers).
// Run: deno test functions/test.ts
//
// Includes local mocks for R2 buckets, postgres.js tagged templates, and
// the global fetch so handlers can be exercised without live infrastructure.

import { assert, assertEquals, assertExists, assertMatch, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";

import {
  findEpisodeThumbnail,
  generateEpisodeId,
  httpsUrl,
  parse,
  parseCategories,
  parseDate,
  parseDuration,
  parseEpisodes,
  parseExplicit,
  sanitizeText,
} from "./_shared/rss.ts";
import { handleSearch } from "./search.ts";
import { handleRssProxy } from "./proxy/rss/[[path]].ts";
import { handleThumbProxy, transformYouTubeThumb } from "./proxy/thumb/[[path]].ts";

// ==================================================================
// Mocks
// ==================================================================

interface SqlCall {
  kind: "template" | "direct";
  strings?: readonly string[];
  values?: unknown[];
  direct?: unknown;
}

interface MockSql {
  (...args: unknown[]): unknown;
  calls: SqlCall[];
  end(): Promise<void>;
}

// Tagged-template postgres.js fake.
// - `sql\`...\`` records a template call and returns a thenable resolving to
//   the next canned response (in order).
// - `sql(obj)` records a direct call and returns the object (so it can be
//   interpolated into an outer template just like postgres.js does).
function mockSql(responses: unknown[] = []): MockSql {
  const calls: SqlCall[] = [];
  let responseIndex = 0;
  const fn = ((...args: unknown[]): unknown => {
    const first = args[0];
    if (Array.isArray(first) && "raw" in (first as object)) {
      const strings = first as readonly string[];
      const values = args.slice(1);
      calls.push({ kind: "template", strings, values });
      const result = responses[responseIndex++] ?? [];
      return Promise.resolve(result);
    }
    calls.push({ kind: "direct", direct: first });
    return first;
  }) as MockSql;
  fn.calls = calls;
  fn.end = () => Promise.resolve();
  return fn;
}

interface MockR2Object {
  body: ReadableStream<Uint8Array>;
  httpMetadata: { contentType?: string } | undefined;
  uploaded: Date;
  text(): Promise<string>;
}

interface R2Entry {
  body: Uint8Array;
  httpMetadata: { contentType?: string } | undefined;
  uploaded?: Date;
}

interface MockR2Bucket {
  get(key: string): Promise<MockR2Object | null>;
  put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  _storage: Map<string, R2Entry>;
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function mockR2Bucket(): MockR2Bucket {
  const storage = new Map<string, R2Entry>();
  return {
    _storage: storage,
    get(key: string): Promise<MockR2Object | null> {
      const entry = storage.get(key);
      if (!entry) return Promise.resolve(null);
      const bytes = entry.body;
      const meta = entry.httpMetadata;
      return Promise.resolve({
        body: new Blob([bytes as BlobPart]).stream(),
        httpMetadata: meta,
        uploaded: entry.uploaded ?? new Date(),
        text: () => Promise.resolve(new TextDecoder().decode(bytes)),
      });
    },
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
      let bytes: Uint8Array;
      if (typeof body === "string") {
        bytes = new TextEncoder().encode(body);
      } else if (body instanceof Uint8Array) {
        bytes = body;
      } else if (body instanceof ReadableStream) {
        bytes = await drainStream(body);
      } else if (body === null) {
        throw new Error("mockR2Bucket.put: body is null");
      } else {
        throw new Error(`mockR2Bucket.put: unsupported body type ${typeof body}`);
      }
      storage.set(key, { body: bytes, httpMetadata: opts?.httpMetadata });
    },
  };
}

async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.error = orig;
  }
}

type MockFetchRoute = Response | (() => Response) | (() => Promise<Response>);
type TaggedFetch = typeof fetch & { calls: string[] };

function mockFetch(routes: Record<string, MockFetchRoute>): TaggedFetch {
  const calls: string[] = [];
  const fn = async (input: Request | URL | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`mockFetch: no mock route for URL ${url}. known routes: ${Object.keys(routes).join(", ")}`);
    }
    if (typeof route === "function") {
      return await route();
    }
    return route.clone();
  };
  const tagged = fn as unknown as TaggedFetch;
  tagged.calls = calls;
  return tagged;
}

// ==================================================================
// Fixtures (inlined XML/HTML)
// ==================================================================

const PODCAST_ITUNES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast &amp; Friends</title>
    <link>https://example.com/podcast</link>
    <description>A test podcast with &lt;b&gt;HTML&lt;/b&gt; tags</description>
    <language>en-us</language>
    <itunes:author>Jane Doe</itunes:author>
    <itunes:explicit>yes</itunes:explicit>
    <itunes:category text="Technology">
      <itunes:category text="Podcasting"/>
    </itunes:category>
    <itunes:image href="https://example.com/podcast.jpg"/>
    <item>
      <title>Episode 1: The Beginning</title>
      <guid>ep1-guid</guid>
      <description>First episode description</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <itunes:season>1</itunes:season>
      <itunes:episode>1</itunes:episode>
      <itunes:explicit>no</itunes:explicit>
      <enclosure url="https://example.com/ep1.mp3" length="12345" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode 2</title>
      <guid>ep2-guid</guid>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>45:30</itunes:duration>
      <enclosure url="https://example.com/ep2.mp3" length="54321" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Atom Test Feed</title>
  <subtitle>A sample Atom feed</subtitle>
  <link rel="alternate" href="https://atom.example.com/"/>
  <link rel="self" href="https://atom.example.com/feed.xml"/>
  <author><name>Atom Author</name></author>
  <icon>https://atom.example.com/icon.png</icon>
  <entry>
    <title>First Atom Entry</title>
    <id>atom-entry-1</id>
    <published>2024-01-01T00:00:00Z</published>
    <link href="https://atom.example.com/1"/>
    <summary>Summary of first entry</summary>
    <media:thumbnail url="https://atom.example.com/thumb1.jpg"/>
  </entry>
  <entry>
    <title>Second Atom Entry</title>
    <id>atom-entry-2</id>
    <published>2024-01-02T00:00:00Z</published>
    <link href="https://atom.example.com/2"/>
  </entry>
</feed>`;

const ATOM_SINGLE_ENTRY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Single Entry Atom</title>
  <link href="https://single.example.com/"/>
  <author><name>Solo</name></author>
  <entry>
    <title>Only Entry</title>
    <id>only-1</id>
    <published>2024-03-15T00:00:00Z</published>
    <link href="https://single.example.com/1"/>
  </entry>
</feed>`;

const YOUTUBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test YouTube Channel</title>
  <yt:channelId>UCtestchannelid12345</yt:channelId>
  <author>
    <name>YT Author</name>
    <uri>https://www.youtube.com/channel/UCtestchannelid12345</uri>
  </author>
  <entry>
    <id>yt:video:abc123</id>
    <yt:videoId>abc123</yt:videoId>
    <title>YouTube Video 1</title>
    <published>2024-01-01T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
    <media:group>
      <media:description>First YT video</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/abc123/hqdefault.jpg"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:def456</id>
    <yt:videoId>def456</yt:videoId>
    <title>YouTube Video 2</title>
    <published>2024-01-02T00:00:00Z</published>
    <link rel="alternate" href="https://www.youtube.com/watch?v=def456"/>
    <media:group>
      <media:description>Second YT video</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/def456/hqdefault.jpg"/>
    </media:group>
  </entry>
</feed>`;

const RDF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RDF xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>RDF Test Feed</title>
    <link>https://rdf.example.com/</link>
    <description>Old school RSS 1.0</description>
    <dc:creator>RDF Author</dc:creator>
    <dc:language>en</dc:language>
  </channel>
  <item>
    <title>RDF Item 1</title>
    <link>https://rdf.example.com/1</link>
    <description>First RDF item</description>
  </item>
  <item>
    <title>RDF Item 2</title>
    <link>https://rdf.example.com/2</link>
    <description>Second RDF item</description>
  </item>
</RDF>`;

const HTML_NOT_A_FEED = `<!DOCTYPE html>
<html>
  <head><title>Not a feed</title></head>
  <body><h1>This is an HTML page, not RSS.</h1></body>
</html>`;

function bigFeedXml(itemCount: number): string {
  const items = Array.from({ length: itemCount }, (_, i) =>
    `<item>
      <title>Item ${i}</title>
      <guid>item-${i}-guid</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <enclosure url="https://example.com/${i}.mp3" length="100" type="audio/mpeg"/>
    </item>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Big Feed</title>
    <link>https://big.example.com/</link>
    <description>A feed with many items</description>
    ${items}
  </channel>
</rss>`;
}

// ==================================================================
// Parser unit tests (functions/_shared/rss.ts)
// ==================================================================

Deno.test("sanitizeText: strips HTML tags", () => {
  assertEquals(sanitizeText("<p>Hello <b>world</b></p>"), "Hello world");
});

Deno.test("sanitizeText: decodes named HTML entities", () => {
  assertEquals(sanitizeText("A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;"), `A & B <C> "D" 'E'`);
  assertEquals(sanitizeText("&nbsp;&ndash;&mdash;"), "\u2013\u2014");
  assertEquals(sanitizeText("&lsquo;x&rsquo; &ldquo;y&rdquo;"), "\u2018x\u2019 \u201Cy\u201D");
  assertEquals(sanitizeText("&hellip;&copy;&reg;&trade;"), "\u2026\u00A9\u00AE\u2122");
});

Deno.test("sanitizeText: decodes numeric and hex entities", () => {
  assertEquals(sanitizeText("&#123;&#x41;"), "{A");
});

Deno.test("sanitizeText: handles CDATA-shaped object input", () => {
  assertEquals(sanitizeText({ "#text": "hello from CDATA" }), "hello from CDATA");
});

Deno.test("sanitizeText: takes first element of array input", () => {
  assertEquals(sanitizeText(["one", "two"]), "one");
});

Deno.test("sanitizeText: collapses whitespace", () => {
  assertEquals(sanitizeText("  a\t\tb\n\nc  "), "a b c");
});

Deno.test("sanitizeText: empty/falsy → null", () => {
  assertEquals(sanitizeText(null), null);
  assertEquals(sanitizeText(undefined), null);
  assertEquals(sanitizeText(""), null);
  assertEquals(sanitizeText("   "), null);
});

Deno.test("parseDuration: HH:MM:SS", () => {
  assertEquals(parseDuration("01:02:03"), 3723);
});

Deno.test("parseDuration: MM:SS", () => {
  assertEquals(parseDuration("45:30"), 2730);
});

Deno.test("parseDuration: seconds only", () => {
  assertEquals(parseDuration("90"), 90);
});

Deno.test("parseDuration: non-numeric → null", () => {
  assertEquals(parseDuration("garbage"), null);
  assertEquals(parseDuration("1:XX:3"), null);
});

Deno.test("parseDuration: 4-part string → null (adversarial)", () => {
  assertEquals(parseDuration("1:2:3:4"), null);
});

Deno.test("parseDuration: null/undefined → null", () => {
  assertEquals(parseDuration(null), null);
  assertEquals(parseDuration(undefined), null);
});

Deno.test("parseExplicit: truthy variants", () => {
  assertEquals(parseExplicit("yes"), true);
  assertEquals(parseExplicit("Yes"), true);
  assertEquals(parseExplicit("true"), true);
  assertEquals(parseExplicit("True"), true);
});

Deno.test("parseExplicit: falsy variants", () => {
  assertEquals(parseExplicit("no"), false);
  assertEquals(parseExplicit("false"), false);
  assertEquals(parseExplicit(""), false);
});

Deno.test("parseExplicit: undefined/null → null", () => {
  assertEquals(parseExplicit(undefined), null);
  assertEquals(parseExplicit(null), null);
});

Deno.test("parseCategories: single category", () => {
  assertEquals(parseCategories({ "@_text": "Technology" }), ["Technology"]);
});

Deno.test("parseCategories: array of categories", () => {
  assertEquals(parseCategories([{ "@_text": "News" }, { "@_text": "Politics" }]), ["News", "Politics"]);
});

Deno.test("parseCategories: nested itunes:category subcategories", () => {
  const raw = {
    "@_text": "Technology",
    "itunes:category": { "@_text": "Podcasting" },
  };
  assertEquals(parseCategories(raw), ["Technology", "Podcasting"]);
});

Deno.test("parseCategories: null → null", () => {
  assertEquals(parseCategories(null), null);
  assertEquals(parseCategories(undefined), null);
});

Deno.test("parseDate: valid ISO string", () => {
  const d = parseDate("2024-01-15T12:30:45Z");
  assertExists(d);
  assertEquals(d.toISOString(), "2024-01-15T12:30:45.000Z");
});

Deno.test("parseDate: valid RFC 2822 string", () => {
  const d = parseDate("Mon, 15 Jan 2024 12:30:45 GMT");
  assertExists(d);
  assertEquals(d.toISOString(), "2024-01-15T12:30:45.000Z");
});

Deno.test("parseDate: invalid string → null (no throw)", () => {
  assertEquals(parseDate("not a date"), null);
});

Deno.test("parseDate: null/undefined → null", () => {
  assertEquals(parseDate(null), null);
  assertEquals(parseDate(undefined), null);
});

Deno.test("generateEpisodeId: deterministic for same input", () => {
  const a = generateEpisodeId({ guid: "foo-bar" });
  const b = generateEpisodeId({ guid: "foo-bar" });
  assertEquals(a, b);
});

Deno.test("generateEpisodeId: different inputs produce different ids", () => {
  const a = generateEpisodeId({ guid: "one" });
  const b = generateEpisodeId({ guid: "two" });
  assert(a !== b, "expected distinct ids for distinct guids");
});

Deno.test("generateEpisodeId: guid preferred over id and link", () => {
  const guidOnly = generateEpisodeId({ guid: "g" });
  const withId = generateEpisodeId({ guid: "g", id: "i", link: "l" });
  assertEquals(guidOnly, withId);
});

Deno.test("generateEpisodeId: object-valued guid handled without throwing", () => {
  const id = generateEpisodeId({ guid: { "#text": "from-cdata" } });
  assert(typeof id === "string" && id.length > 0);
});

Deno.test("findEpisodeThumbnail: itunes:image", () => {
  assertEquals(findEpisodeThumbnail({ "itunes:image": { "@_href": "https://x/1.jpg" } }), "https://x/1.jpg");
});

Deno.test("findEpisodeThumbnail: media:thumbnail", () => {
  assertEquals(findEpisodeThumbnail({ "media:thumbnail": { "@_url": "https://x/2.jpg" } }), "https://x/2.jpg");
});

Deno.test("findEpisodeThumbnail: media:content with medium=image", () => {
  assertEquals(
    findEpisodeThumbnail({ "media:content": [{ "@_medium": "image", "@_url": "https://x/3.jpg" }] }),
    "https://x/3.jpg",
  );
});

Deno.test("findEpisodeThumbnail: image enclosure", () => {
  assertEquals(
    findEpisodeThumbnail({ enclosure: { "@_type": "image/jpeg", "@_url": "https://x/4.jpg" } }),
    "https://x/4.jpg",
  );
});

Deno.test("findEpisodeThumbnail: none → null", () => {
  assertEquals(findEpisodeThumbnail({ title: "no image" }), null);
});

Deno.test("httpsUrl: https passes through", () => {
  assertEquals(httpsUrl("https://example.com/x"), "https://example.com/x");
});

Deno.test("httpsUrl: http → https rewrite", () => {
  assertEquals(httpsUrl("http://example.com/x"), "https://example.com/x");
});

Deno.test("httpsUrl: protocol-relative → https", () => {
  assertEquals(httpsUrl("//example.com/x"), "https://example.com/x");
});

Deno.test("httpsUrl: garbage → null", () => {
  assertEquals(httpsUrl("not-a-url"), null);
  assertEquals(httpsUrl(""), null);
  assertEquals(httpsUrl(null), null);
  assertEquals(httpsUrl(undefined), null);
});

Deno.test("parse: RSS 2.0 podcast", () => {
  const channel = parse(PODCAST_ITUNES_XML);
  assertEquals(channel.title, "Test Podcast & Friends");
  assertEquals(channel.description, "A test podcast with HTML tags");
  assertEquals(channel.author, "Jane Doe");
  assertEquals(channel.language, "en-us");
  assertEquals(channel.explicit, true);
  assertEquals(channel.thumb, "https://example.com/podcast.jpg");
  assertEquals(channel.categories, ["Technology", "Podcasting"]);
  assertEquals(channel.website, "https://example.com/podcast");
});

Deno.test("parse: Atom feed", () => {
  const channel = parse(ATOM_XML);
  assertEquals(channel.title, "Atom Test Feed");
  assertEquals(channel.description, "A sample Atom feed");
  assertEquals(channel.author, "Atom Author");
  assertEquals(channel.website, "https://atom.example.com/");
  assertEquals(channel.thumb, "https://atom.example.com/icon.png");
});

Deno.test("parse: YouTube feed", () => {
  const channel = parse(YOUTUBE_XML);
  assertEquals(channel.channel_id, "youtube.com/channel/UCtestchannelid12345");
  assertEquals(channel.title, "Test YouTube Channel");
  assertEquals(channel.author, "YT Author");
  assertEquals(channel.tags, ["youtube"]);
  assertEquals(channel.thumb, "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
});

Deno.test("parse: RDF / RSS 1.0 feed", () => {
  const channel = parse(RDF_XML);
  assertEquals(channel.title, "RDF Test Feed");
  assertEquals(channel.author, "RDF Author");
  assertEquals(channel.language, "en");
  assertEquals(channel.website, "https://rdf.example.com/");
});

Deno.test("parse: HTML input throws 'Unsupported feed format'", () => {
  assertThrows(() => parse(HTML_NOT_A_FEED), Error, "Unsupported feed format");
});

Deno.test("parse: empty XML throws 'Unsupported feed format'", () => {
  assertThrows(() => parse(""), Error, "Unsupported feed format");
});

Deno.test("parseEpisodes: RSS 2.0 podcast extracts all items", () => {
  const episodes = parseEpisodes(PODCAST_ITUNES_XML, "test-podcast");
  assertEquals(episodes.length, 2);
  assertEquals(episodes[0]?.title, "Episode 1: The Beginning");
  assertEquals(episodes[0]?.channel_id, "test-podcast");
  assertEquals(episodes[0]?.duration_seconds, 3723);
  assertEquals(episodes[0]?.season, 1);
  assertEquals(episodes[0]?.episode, 1);
  assertEquals(episodes[0]?.explicit, false);
  assertEquals(episodes[0]?.src, "https://example.com/ep1.mp3");
  assertEquals(episodes[0]?.src_type, "audio/mpeg");
  assertEquals(episodes[0]?.src_size_bytes, 12345);
  assertExists(episodes[0]?.published_at);
  assertEquals(episodes[1]?.duration_seconds, 2730);
});

Deno.test("parseEpisodes: Atom extracts entries", () => {
  const episodes = parseEpisodes(ATOM_XML, "atom-ch");
  assertEquals(episodes.length, 2);
  assertEquals(episodes[0]?.title, "First Atom Entry");
  assertEquals(episodes[0]?.thumb, "https://atom.example.com/thumb1.jpg");
  assertEquals(episodes[0]?.link, "https://atom.example.com/1");
});

Deno.test("parseEpisodes: Atom with single <entry> (not array) is wrapped", () => {
  const episodes = parseEpisodes(ATOM_SINGLE_ENTRY_XML, "solo");
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]?.title, "Only Entry");
});

Deno.test("parseEpisodes: YouTube feed uses yt:videoId as episode_id", () => {
  const episodes = parseEpisodes(YOUTUBE_XML, "yt-ch");
  assertEquals(episodes.length, 2);
  assertEquals(episodes[0]?.episode_id, "abc123");
  assertEquals(episodes[1]?.episode_id, "def456");
  assertEquals(episodes[0]?.thumb, "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
  assertEquals(episodes[0]?.src, null); // YouTube has no direct media URL
});

Deno.test("parseEpisodes: RDF extracts items", () => {
  const episodes = parseEpisodes(RDF_XML, "rdf-ch");
  assertEquals(episodes.length, 2);
  assertEquals(episodes[0]?.title, "RDF Item 1");
});

Deno.test("parseEpisodes: caps at 50 items even when feed has 100", () => {
  const episodes = parseEpisodes(bigFeedXml(100), "big-ch");
  assertEquals(episodes.length, 50);
});

Deno.test("parseEpisodes: 'Untitled' fallback when title missing", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Missing Titles</title>
  <link>https://mt.example.com/</link>
  <description>x</description>
  <item><guid>a</guid></item>
</channel></rss>`;
  const episodes = parseEpisodes(xml, "mt");
  assertEquals(episodes[0]?.title, "Untitled");
});

// ==================================================================
// Handler integration tests — handleSearch
// ==================================================================

const FAKE_CHANNEL_ROW = {
  channel_id: "example.com/feed",
  rss: "https://example.com/feed",
  title: "Example Feed",
  description: "An example",
  thumb: "https://example.com/thumb.jpg",
  quality: 80,
  tags: ["tech"],
  episode_thumb: "https://example.com/ep.jpg",
};

Deno.test("handleSearch: happy text search returns JSON rows", async () => {
  const sql = mockSql([[], [FAKE_CHANNEL_ROW]]);
  const res = await handleSearch({ sql: sql as any }, { query: "rust" });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  assertEquals(body, [FAKE_CHANNEL_ROW]);
});

Deno.test("handleSearch: records a query with websearch_to_tsquery for text search", async () => {
  const sql = mockSql([[], []]);
  await handleSearch({ sql: sql as any }, { query: "rust" });
  // 2 tagged-template calls: subquery + outer
  const templates = sql.calls.filter(c => c.kind === "template");
  assertEquals(templates.length, 2);
  const outerSql = templates[1]!.strings!.join(" ");
  assertStringIncludes(outerSql, "websearch_to_tsquery");
  // Query string is interpolated as a value, not in the raw SQL
  assertEquals(templates[1]!.values![1], "rust");
});

Deno.test("handleSearch: tag: prefix takes the any(tags) branch", async () => {
  const sql = mockSql([[], []]);
  await handleSearch({ sql: sql as any }, { query: "tag:programming" });
  const templates = sql.calls.filter(c => c.kind === "template");
  const outerSql = templates[1]!.strings!.join(" ");
  assertStringIncludes(outerSql, "= any(tags)");
  // Only the tag name after "tag:" is interpolated
  assertEquals(templates[1]!.values![1], "programming");
});

Deno.test("handleSearch: missing query returns 400 with field name and example", async () => {
  const sql = mockSql();
  const res = await handleSearch({ sql: sql as any }, { query: null });
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, "'q'");
  assertStringIncludes(body, "/search?q=");
  assertEquals(sql.calls.length, 0);
});

Deno.test("handleSearch: empty results return 200 with empty array", async () => {
  const sql = mockSql([[], []]);
  const res = await handleSearch({ sql: sql as any }, { query: "nothing" });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), []);
});

Deno.test("handleSearch: quality threshold appears in generated SQL", async () => {
  const sql = mockSql([[], []]);
  await handleSearch({ sql: sql as any }, { query: "rust" });
  const templates = sql.calls.filter(c => c.kind === "template");
  const outerSql = templates[1]!.strings!.join(" ");
  assertMatch(outerSql, /quality\s*>=\s*/);
  // The threshold (10) is interpolated as a value, not inlined
  assert(templates[1]!.values!.includes(10));
});

// ==================================================================
// Handler integration tests — handleRssProxy
// ==================================================================

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

Deno.test("handleRssProxy: cache hit returns cached body without fetch or sql", async () => {
  const bucket = mockR2Bucket();
  const url = "https://cached.example.com/feed.xml";
  bucket._storage.set(url, { body: new TextEncoder().encode(PODCAST_ITUNES_XML), httpMetadata: undefined });
  const sql = mockSql();
  const fetcher = mockFetch({});
  const res = await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/xml");
  assertStringIncludes(await res.text(), "Test Podcast");
  assertEquals(fetcher.calls.length, 0);
  assertEquals(sql.calls.length, 0);
});

Deno.test("handleRssProxy: cache miss fetches, parses, upserts, caches", async () => {
  const bucket = mockR2Bucket();
  const url = "https://miss.example.com/feed.xml";
  const sql = mockSql([null]); // one template insert, returns null (ignored)
  const fetcher = mockFetch({ [url]: xmlResponse(PODCAST_ITUNES_XML) });
  const res = await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  assertEquals(res.status, 200);
  assertEquals(fetcher.calls, [url]);
  // sql was invoked both as direct (sql(channel)) and as template (insert ... ${...})
  const directs = sql.calls.filter(c => c.kind === "direct");
  const templates = sql.calls.filter(c => c.kind === "template");
  assertEquals(directs.length, 1);
  assertEquals(templates.length, 1);
  // Inserted channel object shape
  const inserted = directs[0]!.direct as { title: string; channel_id: string };
  assertEquals(inserted.title, "Test Podcast & Friends");
  assertEquals(inserted.channel_id, "example.com/podcast");
  // Outer template is an upsert on channel
  const outerSql = templates[0]!.strings!.join(" ");
  assertStringIncludes(outerSql, "insert into channel");
  assertStringIncludes(outerSql, "on conflict");
  // Body now cached
  assertExists(bucket._storage.get(url));
});

Deno.test("handleRssProxy: YouTube feed results in youtube.com/channel/... channel_id", async () => {
  const bucket = mockR2Bucket();
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCtestchannelid12345";
  const sql = mockSql([null]);
  const fetcher = mockFetch({ [url]: xmlResponse(YOUTUBE_XML) });
  await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  const inserted = sql.calls.find(c => c.kind === "direct")!.direct as { channel_id: string; tags: string[] };
  assertEquals(inserted.channel_id, "youtube.com/channel/UCtestchannelid12345");
  assertEquals(inserted.tags, ["youtube"]);
});

Deno.test("handleRssProxy: upstream non-2xx returns 502 with URL and status in message", async () => {
  const bucket = mockR2Bucket();
  const url = "https://dead.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({ [url]: new Response("not found", { status: 404, statusText: "Not Found" }) });
  const res = await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "404");
});

Deno.test("handleRssProxy: fetch rejection returns 502 with URL and cause", async () => {
  const bucket = mockR2Bucket();
  const url = "https://broken.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({ [url]: () => { throw new TypeError("DNS lookup failed"); } });
  const res = await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "DNS lookup failed");
});

Deno.test("handleRssProxy: HTML body returns 400 with URL and missing-root-element hint", async () => {
  const bucket = mockR2Bucket();
  const url = "https://html.example.com/page.html";
  const sql = mockSql();
  const fetcher = mockFetch({ [url]: new Response(HTML_NOT_A_FEED, { status: 200 }) });
  const res = await handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url });
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "<rss>");
  assertStringIncludes(body, "<feed>");
  assertEquals(sql.calls.length, 0);
});

Deno.test("handleRssProxy: gibberish XML bytes → parse throws (let it crash)", async () => {
  const bucket = mockR2Bucket();
  const url = "https://gibberish.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({
    [url]: new Response("<feed>not actually a valid atom feed at all", { status: 200 }),
  });
  // Expect the handler to raise rather than silently swallow.
  await assertRejects(
    () => handleRssProxy({ sql: sql as any, bucket: bucket as unknown as R2Bucket, fetcher }, { rssUrl: url }),
    Error,
  );
});

// ==================================================================
// Handler integration tests — handleThumbProxy
// ==================================================================

Deno.test("transformYouTubeThumb: rewrites hqdefault → mqdefault", () => {
  assertEquals(
    transformYouTubeThumb("https://i.ytimg.com/vi/abc123/hqdefault.jpg"),
    "https://i.ytimg.com/vi/abc123/mqdefault.jpg",
  );
});

Deno.test("transformYouTubeThumb: also rewrites bare default.jpg", () => {
  assertEquals(
    transformYouTubeThumb("https://i.ytimg.com/vi/abc123/default.jpg"),
    "https://i.ytimg.com/vi/abc123/mqdefault.jpg",
  );
});

Deno.test("transformYouTubeThumb: non-YouTube URL passes through", () => {
  assertEquals(
    transformYouTubeThumb("https://example.com/image.jpg"),
    "https://example.com/image.jpg",
  );
});

Deno.test("handleThumbProxy: empty thumb URL → fallback SVG", async () => {
  const bucket = mockR2Bucket();
  const fetcher = mockFetch({});
  const res = await handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl: "" });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(fetcher.calls.length, 0);
});

Deno.test("handleThumbProxy: cache hit returns cached body with immutable header", async () => {
  const bucket = mockR2Bucket();
  const thumbUrl = "https://example.com/img.jpg";
  bucket._storage.set(`small/${thumbUrl}`, {
    body: new TextEncoder().encode("fake-webp-bytes"),
    httpMetadata: { contentType: "image/webp" },
  });
  const fetcher = mockFetch({});
  const res = await handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/webp");
  assertStringIncludes(res.headers.get("cache-control") || "", "immutable");
  assertEquals(fetcher.calls.length, 0);
});

Deno.test("handleThumbProxy: cache miss → fetch → store, applies YouTube transform", async () => {
  const bucket = mockR2Bucket();
  const thumbUrl = "https://i.ytimg.com/vi/abc123/hqdefault.jpg";
  const transformed = "https://i.ytimg.com/vi/abc123/mqdefault.jpg";
  const fetcher = mockFetch({
    [transformed]: new Response("fake-image", {
      status: 200,
      headers: { "content-type": "image/webp" },
    }),
  });
  const res = await handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/webp");
  assertStringIncludes(res.headers.get("cache-control") || "", "immutable");
  assertEquals(fetcher.calls, [transformed]);
  // Now cached
  assertExists(bucket._storage.get(`small/${thumbUrl}`));
});

Deno.test("handleThumbProxy: upstream non-2xx → fallback SVG + logs status and URL", async () => {
  const bucket = mockR2Bucket();
  const thumbUrl = "https://example.com/broken.jpg";
  const fetcher = mockFetch({ [thumbUrl]: new Response("", { status: 503, statusText: "Service Unavailable" }) });
  const { result: res, logs } = await captureConsoleError(() =>
    handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl }),
  );
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "503");
});

Deno.test("handleThumbProxy: non-image content-type → fallback SVG + logs type and URL", async () => {
  const bucket = mockR2Bucket();
  const thumbUrl = "https://example.com/lies.html";
  const fetcher = mockFetch({
    [thumbUrl]: new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  const { result: res, logs } = await captureConsoleError(() =>
    handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl }),
  );
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "text/html");
});

Deno.test("handleThumbProxy: fetch rejection → fallback SVG + logs cause and URL", async () => {
  const bucket = mockR2Bucket();
  const thumbUrl = "https://example.com/nope.jpg";
  const fetcher = mockFetch({ [thumbUrl]: () => { throw new TypeError("DNS lookup failed"); } });
  const { result: res, logs } = await captureConsoleError(() =>
    handleThumbProxy({ bucket: bucket as unknown as R2Bucket, fetcher }, { thumbUrl }),
  );
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "DNS lookup failed");
});
