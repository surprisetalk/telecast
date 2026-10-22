// Integration tests for Telecast backend (parser + worker handlers).
// Run: deno test functions/test.ts
//
// Includes local mocks for postgres.js tagged templates and the global fetch. Caches are real temp dirs.

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
import { type Cache, diskCache } from "./_shared/cache.ts";
import sharp from "sharp";

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

async function tempCache(): Promise<Cache & { dir: string }> {
  const dir = await Deno.makeTempDir();
  return { ...(await diskCache(dir)), dir };
}

// Back-dates every cached file, so the handler sees it as written `ms` ago.
async function age(dir: string, ms: number) {
  const t = new Date(Date.now() - ms);
  for await (const e of Deno.readDir(dir)) await Deno.utime(`${dir}/${e.name}`, t, t);
}

async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
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
    </item>`).join("\n");
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

Deno.test("sanitizeText", () => {
  const rows: { name: string; input: unknown; expected: string | null }[] = [
    { name: "strips tags", input: "<p>Hello <b>world</b></p>", expected: "Hello world" },
    { name: "basic named entities", input: "A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;", expected: `A & B <C> "D" 'E'` },
    { name: "nbsp and dashes", input: "&nbsp;&ndash;&mdash;", expected: "–—" },
    { name: "curly quotes", input: "&lsquo;x&rsquo; &ldquo;y&rdquo;", expected: "‘x’ “y”" },
    { name: "symbols", input: "&hellip;&copy;&reg;&trade;", expected: "…©®™" },
    { name: "numeric and hex entities", input: "&#123;&#x41;", expected: "{A" },
    { name: "names without semicolon stay literal", input: "?a=1&section=2&para=1&copy 2020", expected: "?a=1&section=2&para=1&copy 2020" },
    { name: "CDATA-shaped object", input: { "#text": "hello from CDATA" }, expected: "hello from CDATA" },
    { name: "first element of array", input: ["one", "two"], expected: "one" },
    { name: "collapses whitespace", input: "  a\t\tb\n\nc  ", expected: "a b c" },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
    { name: "empty string", input: "", expected: null },
    { name: "blank string", input: "   ", expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(sanitizeText(input), expected, name);
  assertThrows(() => sanitizeText("a &#99999999; b"), Error, "Numeric entity &#99999999; is out of range");
  assertThrows(() => sanitizeText("&#x110000;"), Error, "Numeric entity &#x110000; is out of range");
  assertThrows(() => sanitizeText("&#12<b></b>3456789;"), Error, "Numeric entity &#123456789; is out of range");
});

Deno.test("parseDuration", () => {
  const rows: { name: string; input: unknown; expected: number | null }[] = [
    { name: "HH:MM:SS", input: "01:02:03", expected: 3723 },
    { name: "MM:SS", input: "45:30", expected: 2730 },
    { name: "seconds only", input: "90", expected: 90 },
    { name: "garbage", input: "garbage", expected: null },
    { name: "non-numeric part", input: "1:XX:3", expected: null },
    { name: "4 parts (adversarial)", input: "1:2:3:4", expected: null },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(parseDuration(input), expected, name);
});

Deno.test("parseExplicit", () => {
  const rows: { name: string; input: unknown; expected: boolean | null }[] = [
    { name: "yes", input: "yes", expected: true },
    { name: "Yes", input: "Yes", expected: true },
    { name: "true", input: "true", expected: true },
    { name: "True", input: "True", expected: true },
    { name: "no", input: "no", expected: false },
    { name: "false", input: "false", expected: false },
    { name: "empty string", input: "", expected: false },
    { name: "undefined", input: undefined, expected: null },
    { name: "null", input: null, expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(parseExplicit(input), expected, name);
});

Deno.test("parseCategories", () => {
  const rows: { name: string; input: unknown; expected: string[] | null }[] = [
    { name: "single category", input: { "@_text": "Technology" }, expected: ["Technology"] },
    { name: "array of categories", input: [{ "@_text": "News" }, { "@_text": "Politics" }], expected: ["News", "Politics"] },
    {
      name: "nested itunes:category subcategories",
      input: { "@_text": "Technology", "itunes:category": { "@_text": "Podcasting" } },
      expected: ["Technology", "Podcasting"],
    },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(parseCategories(input), expected, name);
});

Deno.test("parseDate", () => {
  const rows: { name: string; input: unknown; expected: string | null }[] = [
    { name: "ISO string", input: "2024-01-15T12:30:45Z", expected: "2024-01-15T12:30:45.000Z" },
    { name: "RFC 2822 string", input: "Mon, 15 Jan 2024 12:30:45 GMT", expected: "2024-01-15T12:30:45.000Z" },
    { name: "invalid string does not throw", input: "not a date", expected: null },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(parseDate(input as string)?.toISOString() ?? null, expected, name);
});

Deno.test("generateEpisodeId", () => {
  const rows: { name: string; input: object; other: object; equal: boolean }[] = [
    { name: "deterministic for same input", input: { guid: "foo-bar" }, other: { guid: "foo-bar" }, equal: true },
    { name: "different guids differ", input: { guid: "one" }, other: { guid: "two" }, equal: false },
    { name: "guid preferred over id and link", input: { guid: "g" }, other: { guid: "g", id: "i", link: "l" }, equal: true },
  ];
  for (const { name, input, other, equal } of rows) {
    assertEquals(generateEpisodeId(input) === generateEpisodeId(other), equal, name);
  }
  const id = generateEpisodeId({ guid: { "#text": "from-cdata" } });
  assert(typeof id === "string" && id.length > 0, "object-valued guid gives a non-empty string");
});

Deno.test("findEpisodeThumbnail", () => {
  const rows: { name: string; input: object; expected: string | null }[] = [
    { name: "itunes:image", input: { "itunes:image": { "@_href": "https://x/1.jpg" } }, expected: "https://x/1.jpg" },
    { name: "media:thumbnail", input: { "media:thumbnail": { "@_url": "https://x/2.jpg" } }, expected: "https://x/2.jpg" },
    {
      name: "media:content with medium=image",
      input: { "media:content": [{ "@_medium": "image", "@_url": "https://x/3.jpg" }] },
      expected: "https://x/3.jpg",
    },
    {
      name: "image enclosure",
      input: { enclosure: { "@_type": "image/jpeg", "@_url": "https://x/4.jpg" } },
      expected: "https://x/4.jpg",
    },
    { name: "none", input: { title: "no image" }, expected: null },
  ];
  for (const { name, input, expected } of rows) assertEquals(findEpisodeThumbnail(input), expected, name);
});

Deno.test("httpsUrl", () => {
  const rows: { name: string; input: string | null | undefined; expected: string | null }[] = [
    { name: "https passes through", input: "https://example.com/x", expected: "https://example.com/x" },
    { name: "http rewritten", input: "http://example.com/x", expected: "https://example.com/x" },
    { name: "protocol-relative", input: "//example.com/x", expected: "https://example.com/x" },
    { name: "garbage", input: "not-a-url", expected: null },
    { name: "empty", input: "", expected: null },
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: null },
    { name: "uppercase HTTPS", input: "HTTPS://memorizing.libsyn.com/rss", expected: "https://memorizing.libsyn.com/rss" },
    { name: "mixed-case Http", input: "Http://example.com/feed", expected: "https://example.com/feed" },
    { name: "surrounding whitespace", input: "  https://example.com ", expected: "https://example.com" },
  ];
  for (const { name, input, expected } of rows) assertEquals(httpsUrl(input), expected, name);
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
  // Text branch emits 3 templates: thumb subquery + optional tag fragment + outer.
  const sql = mockSql([[], [], [FAKE_CHANNEL_ROW]]);
  const res = await handleSearch({ sql: sql as any }, { query: "rust" });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  assertEquals(body, [FAKE_CHANNEL_ROW]);
});

Deno.test("handleSearch: records a query with websearch_to_tsquery for text search", async () => {
  const sql = mockSql([[], [], []]);
  await handleSearch({ sql: sql as any }, { query: "rust" });
  const templates = sql.calls.filter((c) => c.kind === "template");
  assertEquals(templates.length, 3);
  const outerSql = templates[2]!.strings!.join(" ");
  assertStringIncludes(outerSql, "websearch_to_tsquery");
  assert(templates[2]!.values!.includes("rust"));
  assert(!outerSql.includes("'rust'"));
});

Deno.test("handleSearch: tag: prefix filters by c.tags @> array", async () => {
  const sql = mockSql([[], []]);
  await handleSearch({ sql: sql as any }, { query: "tag:programming" });
  const templates = sql.calls.filter((c) => c.kind === "template");
  assertEquals(templates.length, 2);
  const outerSql = templates[1]!.strings!.join(" ");
  assertStringIncludes(outerSql, "c.tags @>");
  const tagsArg = templates[1]!.values!.find((v) => Array.isArray(v));
  assertEquals(tagsArg, ["programming"]);
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
  const sql = mockSql([[], [], []]);
  await handleSearch({ sql: sql as any }, { query: "rust" });
  const templates = sql.calls.filter((c) => c.kind === "template");
  const outerSql = templates[2]!.strings!.join(" ");
  assertMatch(outerSql, /quality\s*>=\s*/);
  assert(templates[2]!.values!.includes(10));
});

// ==================================================================
// Handler integration tests — handleRssProxy
// ==================================================================

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

Deno.test("handleRssProxy: cache hit returns cached body without fetch or sql", async () => {
  const cache = await tempCache();
  const url = "https://cached.example.com/feed.xml";
  await cache.put(url, PODCAST_ITUNES_XML);
  const sql = mockSql();
  const fetcher = mockFetch({});
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/xml");
  assertStringIncludes(await res.text(), "Test Podcast");
  assertEquals(fetcher.calls.length, 0);
  assertEquals(sql.calls.length, 0);
});

Deno.test("handleRssProxy: cache miss fetches, parses, upserts, caches", async () => {
  const cache = await tempCache();
  const url = "https://miss.example.com/feed.xml";
  const sql = mockSql([null]); // one template insert, returns null (ignored)
  const fetcher = mockFetch({ [url]: xmlResponse(PODCAST_ITUNES_XML) });
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 200);
  assertEquals(fetcher.calls, [url]);
  // sql was invoked both as direct (sql(channel)) and as template (insert ... ${...})
  const directs = sql.calls.filter((c) => c.kind === "direct");
  const templates = sql.calls.filter((c) => c.kind === "template");
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
  assertExists(await cache.get(url));
});

Deno.test("handleRssProxy: YouTube feed results in youtube.com/channel/... channel_id", async () => {
  const cache = await tempCache();
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=UCtestchannelid12345";
  const sql = mockSql([null]);
  const fetcher = mockFetch({ [url]: xmlResponse(YOUTUBE_XML) });
  await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  const inserted = sql.calls.find((c) => c.kind === "direct")!.direct as { channel_id: string; tags: string[] };
  assertEquals(inserted.channel_id, "youtube.com/channel/UCtestchannelid12345");
  assertEquals(inserted.tags, ["youtube"]);
});

Deno.test("handleRssProxy: upstream non-2xx returns 502 with URL and status in message", async () => {
  const cache = await tempCache();
  const url = "https://dead.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({ [url]: new Response("not found", { status: 404, statusText: "Not Found" }) });
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "404");
});

Deno.test("handleRssProxy: fetch rejection returns 502 with URL and cause", async () => {
  const cache = await tempCache();
  const url = "https://broken.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({
    [url]: () => {
      throw new TypeError("DNS lookup failed");
    },
  });
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "DNS lookup failed");
});

Deno.test("handleRssProxy: origin timeout returns 502 naming the URL and the timeout in ms", async () => {
  const cache = await tempCache();
  const url = "https://slow.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({
    [url]: () => {
      throw new DOMException("signal timed out", "TimeoutError");
    },
  });
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), `Timed out after 15000 ms fetching ${url}`);
});

Deno.test("handleRssProxy: HTML body returns 400 with URL and missing-root-element hint", async () => {
  const cache = await tempCache();
  const url = "https://html.example.com/page.html";
  const sql = mockSql();
  const fetcher = mockFetch({ [url]: new Response(HTML_NOT_A_FEED, { status: 200 }) });
  const res = await handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, url);
  assertStringIncludes(body, "<rss>");
  assertStringIncludes(body, "<feed>");
  assertEquals(sql.calls.length, 0);
});

Deno.test("handleRssProxy: gibberish XML bytes → parse throws (let it crash)", async () => {
  const cache = await tempCache();
  const url = "https://gibberish.example.com/feed.xml";
  const sql = mockSql();
  const fetcher = mockFetch({
    [url]: new Response("<feed>not actually a valid atom feed at all", { status: 200 }),
  });
  // Expect the handler to raise rather than silently swallow.
  await assertRejects(
    () => handleRssProxy({ sql: sql as any, cache, fetcher }, { rssUrl: url }),
    Error,
  );
});

function resolveFetch(extra: (url: string) => Response | undefined): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.includes("/@AtriocClips")) return Promise.resolve(new Response(`"channelId":"UCreal"`));
    return Promise.resolve(extra(url) ?? new Response("nope", { status: 404 }));
  }) as typeof fetch;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

Deno.test("handleRssProxy: @handle → scrape → UULF feed XML", async () => {
  const xml =
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:playlistId>UULFreal</yt:playlistId><title>ok</title><entry><id>x</id><title>t</title><link href="https://y"/><published>2026-01-01T00:00:00Z</published><yt:channelId>UCreal</yt:channelId></entry></feed>`;
  const fetcher = resolveFetch((url) => url.includes("playlist_id=UULFreal") ? new Response(xml) : undefined);
  const res = await handleRssProxy(
    { sql: mockSql() as any, cache: await tempCache(), fetcher },
    { rssUrl: "https://www.youtube.com/@AtriocClips" },
  );
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<yt:playlistId>UULFreal");
});

Deno.test("handleRssProxy: expired cache triggers refetch", async () => {
  const url = "https://example.com/feed.xml";
  const oldXml = `<?xml version="1.0"?><rss><channel><title>old</title></channel></rss>`;
  const newXml = `<?xml version="1.0"?><rss><channel><title>new</title></channel></rss>`;
  const cache = await tempCache();
  await cache.put(url, oldXml);
  await age(cache.dir, TWO_HOURS_MS);
  const fetcher = mockFetch({ [url]: xmlResponse(newXml) });
  const res = await handleRssProxy({ sql: mockSql() as any, cache, fetcher }, { rssUrl: url });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-telecast-stale"), null);
  assertEquals(await res.text(), newXml);
});

Deno.test("handleRssProxy: expired cache + origin failure serves stale", async () => {
  const url = "https://example.com/feed.xml";
  const oldXml = `<?xml version="1.0"?><rss><channel><title>old</title></channel></rss>`;
  const cache = await tempCache();
  await cache.put(url, oldXml);
  await age(cache.dir, TWO_HOURS_MS);
  const fetcher = mockFetch({ [url]: new Response("nope", { status: 500 }) });
  const { result: res, logs } = await captureConsoleError(() => handleRssProxy({ sql: mockSql() as any, cache, fetcher }, { rssUrl: url }));
  assertEquals(logs, [`rss proxy: serving stale ${url}: HTTP 500`]);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-telecast-stale"), "1");
  assertEquals(await res.text(), oldXml);
});

const stalledBody = (headers: HeadersInit = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.error(new DOMException("signal timed out", "TimeoutError"));
      },
    }),
    { headers },
  );

Deno.test("handleRssProxy: body timeout after headers serves stale, else 502 naming URL and timeout", async () => {
  const url = "https://example.com/feed.xml";
  const oldXml = `<?xml version="1.0"?><rss><channel><title>old</title></channel></rss>`;
  const cache = await tempCache();
  await cache.put(url, oldXml);
  await age(cache.dir, TWO_HOURS_MS);
  const fetcher = mockFetch({ [url]: () => stalledBody() });
  const stale = await handleRssProxy({ sql: mockSql() as any, cache, fetcher }, { rssUrl: url });
  assertEquals(stale.headers.get("x-telecast-stale"), "1");
  assertEquals(await stale.text(), oldXml);
  const res = await handleRssProxy({ sql: mockSql() as any, cache: await tempCache(), fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), `Timed out after 15000 ms fetching ${url}`);
});

Deno.test("handleRssProxy: non-ok upstream with an unreadable body still reports the HTTP status", async () => {
  const url = "https://example.com/gone.xml";
  const fetcher = mockFetch({ [url]: () => new Response(stalledBody().body, { status: 404, statusText: "Not Found" }) });
  const res = await handleRssProxy({ sql: mockSql() as any, cache: await tempCache(), fetcher }, { rssUrl: url });
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), "HTTP 404 Not Found");
});

Deno.test("handleRssProxy: error body shows both raw and resolved URL on non-feed response", async () => {
  const fetcher = resolveFetch(() => new Response("<html>youtube is down</html>"));
  const res = await handleRssProxy(
    { sql: mockSql() as any, cache: await tempCache(), fetcher },
    { rssUrl: "https://www.youtube.com/@AtriocClips" },
  );
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, "@AtriocClips", `expected raw input in error, got: ${body}`);
  assertStringIncludes(body, "playlist_id=UULFreal", `expected resolved url in error, got: ${body}`);
  assertStringIncludes(body, "youtube is down", `expected body snippet in error, got: ${body}`);
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
  const cache = await tempCache();
  const fetcher = mockFetch({});
  const res = await handleThumbProxy({ cache, fetcher }, { thumbUrl: "" });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(fetcher.calls.length, 0);
});

Deno.test("handleThumbProxy: cache hit returns cached body with immutable header", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/img.jpg";
  await cache.put(`small/${thumbUrl}`, "fake-webp-bytes");
  const fetcher = mockFetch({});
  const res = await handleThumbProxy({ cache, fetcher }, { thumbUrl });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/webp");
  assertStringIncludes(res.headers.get("cache-control") || "", "immutable");
  assertEquals(fetcher.calls.length, 0);
});

Deno.test("handleThumbProxy: cache miss → fetch → resize to 256 px webp → store, applies YouTube transform", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://i.ytimg.com/vi/abc123/hqdefault.jpg";
  const transformed = "https://i.ytimg.com/vi/abc123/mqdefault.jpg";
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#f00" } }).png().toBuffer();
  const fetcher = mockFetch({ [transformed]: () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }) });
  const res = await handleThumbProxy({ cache, fetcher }, { thumbUrl });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/webp");
  assertStringIncludes(res.headers.get("cache-control") || "", "immutable");
  assertEquals(fetcher.calls, [transformed]);
  const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
  assertEquals([meta.format, meta.width], ["webp", 256]);
  assertExists(await cache.get(`small/${thumbUrl}`));
});

Deno.test("handleThumbProxy: bytes sharp cannot read → fallback SVG + logs type and URL, caches nothing", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/corrupt.jpg";
  const fetcher = mockFetch({ [thumbUrl]: new Response("fake-image", { headers: { "content-type": "image/jpeg" } }) });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, `sharp could not resize image/jpeg from ${thumbUrl}`);
  assertEquals(await Array.fromAsync(Deno.readDir(cache.dir)), []);
});

// A body of `mb` 1 MB chunks with no content-length, so only counting bytes can stop it.
const bigBody = (mb: number, headers: HeadersInit) => {
  const chunk = new Uint8Array(1 << 20);
  let sent = 0;
  return new Response(new ReadableStream({ pull: (c) => sent++ < mb ? c.enqueue(chunk) : c.close() }), { headers });
};

Deno.test("handleThumbProxy: a body over 20 MB → fallback SVG + logs URL and cap, caches nothing", async () => {
  const thumbUrl = "https://example.com/huge.png";
  for (
    const upstream of [
      () => bigBody(21, { "content-type": "image/png" }),
      () => new Response("x", { headers: { "content-type": "image/png", "content-length": "21000000" } }),
    ]
  ) {
    const cache = await tempCache();
    const { result: res, logs } = await captureConsoleError(() =>
      handleThumbProxy({ cache, fetcher: mockFetch({ [thumbUrl]: upstream }) }, { thumbUrl })
    );
    assertEquals(res.headers.get("content-type"), "image/svg+xml");
    assertEquals(logs, [`thumb proxy: body from ${thumbUrl} is larger than 20 MB. Expected an image under 20 MB.`]);
    assertEquals(await Array.fromAsync(Deno.readDir(cache.dir)), []);
  }
});

Deno.test("handleRssProxy: a body over 50 MB returns 502 naming the URL and the cap", async () => {
  const url = "https://example.com/huge.xml";
  const res = await handleRssProxy(
    { sql: mockSql() as any, cache: await tempCache(), fetcher: mockFetch({ [url]: () => bigBody(51, {}) }) },
    { rssUrl: url },
  );
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), `Feed at ${url} is larger than 50 MB. Expected a feed under 50 MB.`);
});

Deno.test("proxies: a scheme other than http or https returns 400 before any fetch or cache read", async () => {
  for (const url of ["file:///etc/hostname", "resolved2:https://example.com/feed.xml", "data:text/xml,<rss>"]) {
    const fetcher = mockFetch({});
    const expected = `Expected an http or https URL, received ${url}. Encode the URL with encodeURIComponent.`;
    const rss = await handleRssProxy({ sql: mockSql() as any, cache: await tempCache(), fetcher }, { rssUrl: url });
    assertEquals([rss.status, await rss.text()], [400, expected]);
    const thumb = await handleThumbProxy({ cache: await tempCache(), fetcher }, { thumbUrl: url });
    assertEquals([thumb.status, await thumb.text()], [400, expected]);
    assertEquals(fetcher.calls, []);
  }
});

Deno.test("handleThumbProxy: upstream non-2xx → fallback SVG + logs status and URL", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/broken.jpg";
  const fetcher = mockFetch({ [thumbUrl]: new Response("", { status: 503, statusText: "Service Unavailable" }) });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "503");
});

Deno.test("handleThumbProxy: non-image content-type → fallback SVG + logs type and URL", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/lies.html";
  const fetcher = mockFetch({
    [thumbUrl]: new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "text/html");
});

Deno.test("handleThumbProxy: fetch rejection → fallback SVG + logs cause and URL", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/nope.jpg";
  const fetcher = mockFetch({
    [thumbUrl]: () => {
      throw new TypeError("DNS lookup failed");
    },
  });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, thumbUrl);
  assertStringIncludes(logs[0]!, "DNS lookup failed");
});

Deno.test("handleThumbProxy: fetch timeout → fallback SVG + logs URL and timeout in ms", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/slow.jpg";
  const fetcher = mockFetch({
    [thumbUrl]: () => {
      throw new DOMException("signal timed out", "TimeoutError");
    },
  });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, `Timed out after 10000 ms fetching ${thumbUrl}`);
});

Deno.test("handleThumbProxy: body timeout after headers → fallback SVG + logs URL and timeout in ms", async () => {
  const cache = await tempCache();
  const thumbUrl = "https://example.com/stall.jpg";
  const fetcher = mockFetch({ [thumbUrl]: () => stalledBody({ "content-type": "image/jpeg" }) });
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, `Timed out after 10000 ms fetching ${thumbUrl}`);
  assertEquals(await Array.fromAsync(Deno.readDir(cache.dir)), []);
});

Deno.test("handleThumbProxy: non-ok upstream with an unreadable body logs the HTTP status", async () => {
  const thumbUrl = "https://example.com/gone.jpg";
  const fetcher = mockFetch({ [thumbUrl]: () => new Response(stalledBody().body, { status: 404, statusText: "Not Found" }) });
  const cache = await tempCache();
  const { result: res, logs } = await captureConsoleError(() => handleThumbProxy({ cache, fetcher }, { thumbUrl }));
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(logs, [`thumb proxy: upstream 404 Not Found for ${thumbUrl}`]);
});
