import { decodeHTMLStrict } from "entities";
import { XMLParser } from "fast-xml-parser";

export interface Channel {
  channel_id: string;
  // null when the feed has no https <link>. The channel table needs it, so the RSS proxy and seed skip such a feed.
  rss: string | null;
  title: string | null;
  description: string | null;
  thumb: string | null;
  updated_at: Date;
  author: string | null;
  language: string | null;
  explicit: boolean | null;
  website: string | null;
  categories: string[] | null;
  tags: string[] | null;
}

export interface Episode {
  channel_id: string;
  episode_id: string;
  title: string;
  description: string | null;
  thumb: string | null;
  src: string | null;
  src_type: string | null;
  src_size_bytes: number | null;
  duration_seconds: number | null;
  published_at: Date | null;
  link: string | null;
  season: number | null;
  episode: number | null;
  explicit: boolean | null;
}

// The parser gives an element as an object with attributes under "@_" and text under "#text", a repeated tag as an array, and
// text as a string, or as a number or boolean when the text parses as one. Its types say any, so the code below reads unknown.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

// Follows tags through elements. An array or text on the path gives undefined, as `?.` did on the parser's any.
const get = (node: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (n, tag) => (n !== null && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>)[tag] : undefined),
    node,
  );
const list = (node: unknown): unknown[] => (!node ? [] : Array.isArray(node) ? node : [node]);
const str = (node: unknown): string | undefined => (typeof node === "string" ? node : undefined);

// fast-xml-parser returns an array for a repeated tag. The first one wins, as in sanitizeText.
function extractText(raw: unknown): string {
  const node = Array.isArray(raw) ? raw[0] : raw;
  const text = typeof node === "object" ? get(node, "#text") : String(node);
  if (typeof text !== "string") {
    throw new Error(`Expected text, received ${JSON.stringify(node)?.slice(0, 80)}. The feed is malformed: report it to the publisher.`);
  }
  return text;
}

const INT32_MAX = 2 ** 31 - 1;
// tsvector holds 1 MiB. The keywords of a channel join 20 episodes of title and description.
const MAX_TEXT_CHARS = 10_000;

// Every value that reaches SQL must fit its db.sql column. A value that cannot fit rejects the feed here,
// so the channel records a parse failure and the database never sees it.
// A checker returns what it received when the value does not fit, and null when it fits.
type Checker = (x: unknown) => string | null;
const nonNull = (x: unknown, c: Checker): string | null => (x === null || x === undefined ? null : c(x));
const text: Checker = (x) =>
  nonNull(x, (v) => typeof v === "string" && v.includes("\0") ? "a NUL byte, which postgres text cannot hold" : null);
const textList: Checker = (x) => nonNull(x, (v) => (v as unknown[]).map(text).find((r) => r !== null) ?? null);
const bool: Checker = () => null;
const intWithin = (max: number): Checker => (x) =>
  nonNull(x, (v) => Number.isInteger(v) && Math.abs(v as number) <= max ? null : `the number ${v}`);
const int32 = intWithin(INT32_MAX);
// A bigint column. A JS number is exact up to 2^53, so that bounds it.
const int64 = intWithin(Number.MAX_SAFE_INTEGER);
// postgres.js writes years outside 1 to 9999 in a form that postgres rejects.
const timestamp: Checker = (x) =>
  nonNull(x, (v) => {
    const y = (v as Date).getUTCFullYear();
    return y >= 1 && y <= 9999 ? null : `the date ${(v as Date).toISOString()}`;
  });

const channelChecks = {
  channel_id: text,
  rss: text,
  title: text,
  description: text,
  thumb: text,
  updated_at: timestamp,
  author: text,
  language: text,
  explicit: bool,
  website: text,
  categories: textList,
  tags: textList,
} satisfies Record<keyof Channel, Checker>;

const episodeChecks = {
  channel_id: text,
  episode_id: text,
  title: text,
  description: text,
  thumb: text,
  src: text,
  src_type: text,
  src_size_bytes: int64,
  duration_seconds: int32,
  published_at: timestamp,
  link: text,
  season: int32,
  episode: int32,
  explicit: bool,
} satisfies Record<keyof Episode, Checker>;

function fit<T extends object>(row: T, checks: Record<keyof T, Checker>, source: string): T {
  for (const field of Object.keys(checks) as (keyof T & string)[]) {
    const received = checks[field](row[field]);
    if (received !== null) {
      throw new Error(
        `Expected ${source} field ${field} to fit its db.sql column, received ${received}. The feed is malformed: report it to the publisher.`,
      );
    }
  }
  return row;
}

export function httpsUrl(url: unknown): string | null {
  if (!url) return null;
  if (typeof url !== "string") {
    throw new Error(
      `Expected a URL string, received ${JSON.stringify(url)?.slice(0, 80)}. The feed is malformed: report it to the publisher.`,
    );
  }
  const s = url.trim();
  if (/^https:\/\//i.test(s)) return "https://" + s.slice(8);
  if (/^http:\/\//i.test(s)) return "https://" + s.slice(7);
  if (s.startsWith("//")) return "https:" + s;
  return null;
}

export function sanitizeText(raw: unknown): string | null {
  // fast-xml-parser returns an array for a repeated tag, and keeps CDATA, or the text of an element with attributes, under "#text".
  const node = Array.isArray(raw) ? raw[0] : raw;
  if (!node) return null;
  let text = String(typeof node === "object" ? get(node, "#text") || node : node);

  text = text.replace(/<[^>]*>/g, "");
  for (const m of text.matchAll(/&#(?:x([0-9a-f]+)|(\d+));/gi)) {
    const cp = m[1] ? parseInt(m[1], 16) : Number(m[2]);
    if (cp > 0x10ffff) {
      throw new Error(
        `Numeric entity ${m[0]} is out of range. Expected a code point up to 0x10FFFF, received ${cp}, in text starting ${
          JSON.stringify(text.slice(0, 80))
        }. The feed is malformed: report it to the publisher or add it to blocked.`,
      );
    }
  }
  text = decodeHTMLStrict(text);

  text = text.replace(/\s+/g, " ").trim();

  // REVIEW: Cut text to MAX_TEXT_CHARS. Alternative: reject the feed. It keeps the data whole but fails every channel with long show notes.
  text = text.slice(0, MAX_TEXT_CHARS).replace(/[\ud800-\udbff]$/, "").trim();

  return text || null;
}

export function parseDuration(raw: unknown): number | null {
  if (!raw) return null;
  const str = extractText(raw);

  // Handle HH:MM:SS or MM:SS format
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;

  const [a = 0, b = 0, c = 0] = parts;
  // The column is integer, and a feed may say "1.5".
  if (parts.length === 3) return Math.round(a * 3600 + b * 60 + c);
  if (parts.length === 2) return Math.round(a * 60 + b);
  if (parts.length === 1) return Math.round(a); // Already seconds
  return null;
}

export function parseExplicit(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  return ["yes", "true"].includes(extractText(raw).toLowerCase());
}

export function parseCategories(raw: unknown): string[] | null {
  // A category may nest its subcategories.
  const result = list(raw).flatMap((cat) => [cat, ...list(get(cat, "itunes:category"))]).flatMap((c) => str(get(c, "@_text")) || []);
  return result.length > 0 ? result : null;
}

export function parseDate(raw: unknown): Date | null {
  if (!raw) return null;
  const date = new Date(extractText(raw));
  return isNaN(date.getTime()) ? null : date;
}

// The old parser read item.link on an <item> that holds only text, received String.prototype.link, and hashed its source. Stored
// episodes carry that id, so a text item keeps it.
const TEXT_ITEM_KEY = "function link() { [native code] }";

export function generateEpisodeId(item: unknown): string {
  // Prefer guid, then id, then link
  const raw = typeof item === "string"
    ? TEXT_ITEM_KEY
    : get(item, "guid", "#text") || get(item, "guid") || get(item, "id") || get(item, "link", "@_href") || get(item, "link") ||
      "";
  const key = typeof raw === "object" ? JSON.stringify(raw) : String(raw);

  // Create a simple hash for deterministic IDs
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function findEpisodeThumbnail(item: unknown): string | null {
  const image = list(get(item, "media:content")).find((c) => get(c, "@_medium") === "image" || str(get(c, "@_type"))?.startsWith("image/"));
  const enclosure = get(item, "enclosure");
  const enclosureImage = str(get(enclosure, "@_type"))?.startsWith("image/") ? str(get(enclosure, "@_url")) : undefined;
  return str(get(item, "itunes:image", "@_href")) || str(get(item, "media:thumbnail", "@_url")) || str(get(image, "@_url")) ||
    enclosureImage || null;
}

function extractYoutubeChannelId(feed: unknown): string | null {
  const direct = get(feed, "yt:channelId");
  if (typeof direct === "string" && direct.startsWith("UC")) return direct;
  const playlist = get(feed, "yt:playlistId");
  if (typeof playlist === "string" && playlist.startsWith("UULF")) return "UC" + playlist.slice(4);
  const fromEntry = get(list(get(feed, "entry"))[0], "yt:channelId");
  if (typeof fromEntry === "string" && fromEntry.startsWith("UC")) return fromEntry;
  return null;
}

export function parseEpisodes(xmlText: string, channelId: string): Episode[] {
  return episodes(xmlText, channelId).map((e, i) => fit(e, episodeChecks, `episode ${i + 1} (${JSON.stringify(e.title.slice(0, 40))})`));
}

function episodes(xmlText: string, channelId: string): Episode[] {
  const xml: unknown = parser.parse(xmlText);
  const feed = get(xml, "feed");

  if (extractYoutubeChannelId(feed)) {
    return list(get(feed, "entry")).slice(0, 50).map((item) => ({
      channel_id: channelId,
      // A video id of digits parses as a number.
      episode_id: get(item, "yt:videoId") ? extractText(get(item, "yt:videoId")) : generateEpisodeId(item),
      title: sanitizeText(get(item, "title")) || "Untitled",
      description: sanitizeText(get(item, "media:group", "media:description")),
      thumb: httpsUrl(get(item, "media:group", "media:thumbnail", "@_url")),
      src: null, // YouTube embeds don't have direct media URLs
      src_type: null,
      src_size_bytes: null,
      duration_seconds: null,
      published_at: parseDate(get(item, "published")),
      link: httpsUrl(get(item, "link", "@_href")),
      season: null,
      episode: null,
      explicit: null,
    }));
  }

  const items = list(get(feed, "entry") || get(xml, "rss", "channel", "item") || get(xml, "RDF", "item"));
  return items.slice(0, 50).map((item) => {
    const enclosure = get(item, "enclosure");
    const link = get(item, "link");
    const size = str(get(enclosure, "@_length"));
    const season = get(item, "itunes:season");
    const number = get(item, "itunes:episode");
    return {
      channel_id: channelId,
      episode_id: generateEpisodeId(item),
      title: sanitizeText(get(item, "title")) || "Untitled",
      description: sanitizeText(get(item, "description") || get(item, "summary") || get(item, "content")),
      thumb: httpsUrl(findEpisodeThumbnail(item)),
      src: httpsUrl(get(enclosure, "@_url")),
      src_type: str(get(enclosure, "@_type")) || null,
      src_size_bytes: size ? parseInt(size, 10) || null : null,
      duration_seconds: parseDuration(get(item, "itunes:duration")),
      published_at: parseDate(get(item, "pubDate") || get(item, "published")),
      link: httpsUrl(get(link, "@_href") || (typeof link === "string" ? link : null)),
      season: season ? parseInt(String(season), 10) || null : null,
      episode: number ? parseInt(String(number), 10) || null : null,
      explicit: parseExplicit(get(item, "itunes:explicit")),
    };
  });
}

function generateChannelId(url: unknown): string {
  try {
    const urlObj = new URL(String(url));
    return urlObj.hostname + urlObj.pathname;
  } catch {
    return btoa(encodeURIComponent(String(url))).slice(0, 32);
  }
}

// refresh records a throw as a failed channel. The old parser threw for a <channel> that is missing or holds only text, so such a
// feed fails and does not refresh a channel with nothing.
function channelOf(xml: unknown, root: "rss" | "RDF"): unknown {
  const channel = get(xml, root, "channel");
  if (typeof channel !== "object") {
    throw new Error(
      `Expected <${root}> to have a <channel> element, received ${
        channel === undefined ? "none" : JSON.stringify(channel)?.slice(0, 80)
      }. The feed is malformed: report it to the publisher.`,
    );
  }
  return channel;
}

// The result goes to httpsUrl unnarrowed, so an image that is not text fails the feed.
function findThumbnail(channel: unknown): unknown {
  return get(channel, "image", "url") || get(channel, "itunes:image", "@_href") || get(channel, "media:thumbnail", "@_url") || null;
}

export function parse(xmlText: string, sourceUrl?: string): Channel {
  return fit(channel(xmlText, sourceUrl), channelChecks, "channel");
}

function channel(xmlText: string, sourceUrl?: string): Channel {
  const xml: unknown = parser.parse(xmlText);

  const feed = get(xml, "feed");
  if (feed) {
    const ytChannelId = extractYoutubeChannelId(feed);
    if (ytChannelId) {
      const authorUri = httpsUrl(get(feed, "author", "uri"));
      const channelUrl = `https://www.youtube.com/channel/${ytChannelId}`;
      return {
        channel_id: `youtube.com/channel/${ytChannelId}`,
        rss: sourceUrl || authorUri || channelUrl,
        title: sanitizeText(get(feed, "title")),
        description: sanitizeText(get(feed, "subtitle")),
        thumb: httpsUrl(get(list(get(feed, "entry"))[0], "media:group", "media:thumbnail", "@_url")),
        updated_at: new Date(),
        author: sanitizeText(get(feed, "author", "name")) || null,
        language: null,
        explicit: null,
        website: authorUri || channelUrl,
        categories: null,
        tags: ["youtube"],
      };
    }
    // The old parser threw for an Atom feed with no <link>. A <link> that holds text keeps its feed, which can still list entries.
    if (get(feed, "link") === undefined) {
      throw new Error("Expected <feed> to have a <link>, received none. The feed is malformed: report it to the publisher.");
    }
    const links = list(get(feed, "link"));
    const rawLink = get(links.find((l) => get(l, "@_rel") === "alternate"), "@_href") || get(links[0], "@_href");
    const link = httpsUrl(rawLink);
    return {
      channel_id: generateChannelId(rawLink),
      rss: link,
      title: sanitizeText(get(feed, "title")),
      description: sanitizeText(get(feed, "subtitle") || get(feed, "description")),
      thumb: httpsUrl(get(feed, "icon") || get(feed, "logo") || get(feed, "media:thumbnail", "@_url")),
      updated_at: new Date(),
      author: sanitizeText(get(feed, "author", "name")) || null,
      language: str(get(feed, "@_xml:lang")) || null,
      explicit: parseExplicit(get(feed, "itunes:explicit")),
      website: link || null,
      categories: parseCategories(get(feed, "itunes:category")),
      tags: null,
    };
  }

  if (get(xml, "rss")) {
    const channel = channelOf(xml, "rss");
    const link = httpsUrl(get(channel, "link"));
    return {
      channel_id: generateChannelId(get(channel, "link")),
      rss: link,
      title: sanitizeText(get(channel, "title")),
      description: sanitizeText(get(channel, "description")),
      thumb: httpsUrl(findThumbnail(channel)),
      updated_at: new Date(),
      author: sanitizeText(get(channel, "itunes:author")) || null,
      language: sanitizeText(get(channel, "language")) || null,
      explicit: parseExplicit(get(channel, "itunes:explicit")),
      website: link,
      categories: parseCategories(get(channel, "itunes:category")),
      tags: null,
    };
  }

  if (get(xml, "RDF")) {
    const channel = channelOf(xml, "RDF");
    const link = httpsUrl(get(channel, "link"));
    return {
      channel_id: generateChannelId(get(channel, "link")),
      rss: link,
      title: sanitizeText(get(channel, "title")),
      description: sanitizeText(get(channel, "description")),
      thumb: httpsUrl(findThumbnail(channel)),
      updated_at: new Date(),
      author: sanitizeText(get(channel, "dc:creator")) || null,
      language: sanitizeText(get(channel, "dc:language")) || null,
      explicit: null,
      website: link,
      categories: null,
      tags: null,
    };
  }

  throw new Error("Unsupported feed format");
}
