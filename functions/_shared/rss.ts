import { XMLParser } from "fast-xml-parser";

export interface Channel {
  channel_id: string;
  rss: string;
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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function extractText(raw: any): string {
  return typeof raw === "object" ? raw["#text"] : String(raw);
}

export function httpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  if (/^https:\/\//i.test(s)) return "https://" + s.slice(8);
  if (/^http:\/\//i.test(s)) return "https://" + s.slice(7);
  if (s.startsWith("//")) return "https:" + s;
  return null;
}

export function sanitizeText(text: any): string | null {
  if (!text) return null;

  // Handle arrays - take first element (fast-xml-parser returns arrays for duplicate tags)
  if (Array.isArray(text)) text = text[0];
  if (!text) return null;

  // Handle CDATA or object values
  if (typeof text === "object") text = (text as any)["#text"] || String(text);

  // Ensure we have a string
  if (typeof text !== "string") text = String(text);

  // Remove HTML tags
  text = text.replace(/<[^>]*>/g, "");

  // Decode HTML entities
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "\u2013",
    "&mdash;": "\u2014",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&hellip;": "\u2026",
    "&copy;": "\u00A9",
    "&reg;": "\u00AE",
    "&trade;": "\u2122",
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.replaceAll(entity, char);
  }
  // Decode numeric entities: &#123; and &#x1F;
  text = text.replace(/&#(\d+);/g, (_: string, code: string) => String.fromCodePoint(parseInt(code, 10)));
  text = text.replace(/&#x([0-9a-fA-F]+);/gi, (_: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)));

  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text || null;
}

export function parseDuration(raw: any): number | null {
  if (!raw) return null;
  const str = extractText(raw);

  // Handle HH:MM:SS or MM:SS format
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;

  const [a = 0, b = 0, c = 0] = parts;
  if (parts.length === 3) return a * 3600 + b * 60 + c;
  if (parts.length === 2) return a * 60 + b;
  if (parts.length === 1) return a; // Already seconds
  return null;
}

export function parseExplicit(raw: any): boolean | null {
  if (raw === undefined || raw === null) return null;
  return ["yes", "true"].includes(extractText(raw).toLowerCase());
}

export function parseCategories(raw: any): string[] | null {
  if (!raw) return null;
  const cats = Array.isArray(raw) ? raw : [raw];
  const result: string[] = [];
  for (const cat of cats) {
    const text = cat["@_text"];
    if (text) result.push(text);
    // Also check for nested subcategories
    if (cat["itunes:category"]) {
      const nested = Array.isArray(cat["itunes:category"]) ? cat["itunes:category"] : [cat["itunes:category"]];
      for (const sub of nested) {
        if (sub["@_text"]) result.push(sub["@_text"]);
      }
    }
  }
  return result.length > 0 ? result : null;
}

export function parseDate(raw: any): Date | null {
  if (!raw) return null;
  const str = extractText(raw);
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

export function generateEpisodeId(item: any): string {
  // Prefer guid, then id, then link
  const raw = item.guid?.["#text"] || item.guid || item.id || item.link?.["@_href"] || item.link || "";
  const str = typeof raw === "object" ? JSON.stringify(raw) : String(raw);

  // Create a simple hash for deterministic IDs
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function findEpisodeThumbnail(item: any): string | null {
  // Try itunes:image
  if (item["itunes:image"]?.["@_href"]) return item["itunes:image"]["@_href"];

  // Try media:thumbnail
  if (item["media:thumbnail"]?.["@_url"]) return item["media:thumbnail"]["@_url"];

  // Try media:content with medium="image"
  const mediaContent = item["media:content"];
  if (mediaContent) {
    const contents = Array.isArray(mediaContent) ? mediaContent : [mediaContent];
    const image = contents.find((c) => c["@_medium"] === "image" || c["@_type"]?.startsWith("image/"));
    if (image?.["@_url"]) return image["@_url"];
  }

  // Try enclosure with image type
  const enclosure = item.enclosure;
  if (enclosure?.["@_type"]?.startsWith("image/") && enclosure["@_url"]) return enclosure["@_url"];

  return null;
}

export function parseEpisodes(xmlText: string, channelId: string): Episode[] {
  const xml = parser.parse(xmlText);

  // Check for YouTube feed (yt:channelId exists but may not have "UC" prefix at channel level)
  const ytChannelId = xml.feed?.["yt:channelId"];
  if (typeof ytChannelId === "string" && ytChannelId.length > 0) {
    const entries = xml.feed.entry;
    const items = Array.isArray(entries) ? entries : entries ? [entries] : [];
    return items.slice(0, 50).map((item: any) => {
      return {
        channel_id: channelId,
        episode_id: item["yt:videoId"] || generateEpisodeId(item),
        title: sanitizeText(item.title) || "Untitled",
        description: sanitizeText(item["media:group"]?.["media:description"]),
        thumb: httpsUrl(item["media:group"]?.["media:thumbnail"]?.["@_url"]),
        src: null, // YouTube embeds don't have direct media URLs
        src_type: null,
        src_size_bytes: null,
        duration_seconds: null,
        published_at: parseDate(item.published),
        link: httpsUrl(item.link?.["@_href"]),
        season: null,
        episode: null,
        explicit: null,
      };
    });
  }

  // Extract items from RSS/Atom/RDF
  let items: any[] = [];
  if (xml.feed?.entry) items = Array.isArray(xml.feed.entry) ? xml.feed.entry : [xml.feed.entry];
  else if (xml.rss?.channel?.item) items = Array.isArray(xml.rss.channel.item) ? xml.rss.channel.item : [xml.rss.channel.item];
  else if (xml.RDF?.item) items = Array.isArray(xml.RDF.item) ? xml.RDF.item : [xml.RDF.item];

  return items.slice(0, 50).map((item) => {
    const thumb = findEpisodeThumbnail(item);
    const enclosure = item.enclosure;
    const enclosureUrl = enclosure?.["@_url"];
    const itemLink = item.link?.["@_href"] || (typeof item.link === "string" ? item.link : null);
    const sizeRaw = enclosure?.["@_length"];
    return {
      channel_id: channelId,
      episode_id: generateEpisodeId(item),
      title: sanitizeText(item.title) || "Untitled",
      description: sanitizeText(item.description || item.summary || item.content),
      thumb: httpsUrl(thumb),
      src: httpsUrl(enclosureUrl),
      src_type: enclosure?.["@_type"] || null,
      src_size_bytes: sizeRaw ? parseInt(sizeRaw, 10) || null : null,
      duration_seconds: parseDuration(item["itunes:duration"]),
      published_at: parseDate(item.pubDate || item.published),
      link: httpsUrl(itemLink),
      season: item["itunes:season"] ? parseInt(item["itunes:season"], 10) || null : null,
      episode: item["itunes:episode"] ? parseInt(item["itunes:episode"], 10) || null : null,
      explicit: parseExplicit(item["itunes:explicit"]),
    };
  });
}

function generateChannelId(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname + urlObj.pathname;
  } catch {
    return btoa(encodeURIComponent(url)).slice(0, 32);
  }
}

function findThumbnail(channel: any): string | null {
  if (channel.image?.url) return channel.image.url;
  if (channel["itunes:image"]?.["@_href"]) return channel["itunes:image"]["@_href"];
  if (channel["media:thumbnail"]?.["@_url"]) return channel["media:thumbnail"]["@_url"];
  return null;
}

export function parse(xmlText: string): Channel {
  const xml = parser.parse(xmlText);

  if (xml.feed) {
    const feed = xml.feed;
    const ytChannelId = feed["yt:channelId"];
    if (typeof ytChannelId === "string" && ytChannelId.startsWith("UC")) {
      const authorUri = httpsUrl(feed.author?.uri);
      const entries = feed.entry;
      const firstEntry = Array.isArray(entries) ? entries[0] : entries;
      const channelUrl = `https://www.youtube.com/channel/${ytChannelId}`;
      return {
        channel_id: `youtube.com/channel/${ytChannelId}`,
        rss: authorUri || channelUrl,
        title: sanitizeText(feed.title),
        description: sanitizeText(feed.subtitle),
        thumb: httpsUrl(firstEntry?.["media:group"]?.["media:thumbnail"]?.["@_url"]),
        updated_at: new Date(),
        author: sanitizeText(feed.author?.name) || null,
        language: null,
        explicit: null,
        website: authorUri || channelUrl,
        categories: null,
        tags: ["youtube"],
      };
    }
    const rawLink = Array.isArray(feed.link)
      ? feed.link.find((l: any) => l["@_rel"] === "alternate")?.["@_href"] || feed.link[0]["@_href"]
      : feed.link["@_href"];
    const link = httpsUrl(rawLink);
    return {
      channel_id: generateChannelId(rawLink),
      rss: link!,
      title: sanitizeText(feed.title),
      description: sanitizeText(feed.subtitle || feed.description),
      thumb: httpsUrl(feed.icon || feed.logo || feed["media:thumbnail"]?.["@_url"]),
      updated_at: new Date(),
      author: sanitizeText(feed.author?.name) || null,
      language: feed["@_xml:lang"] || null,
      explicit: parseExplicit(feed["itunes:explicit"]),
      website: link || null,
      categories: parseCategories(feed["itunes:category"]),
      tags: null,
    };
  }

  if (xml.rss) {
    const channel = xml.rss.channel;
    const link = httpsUrl(channel.link);
    return {
      channel_id: generateChannelId(channel.link),
      rss: link!,
      title: sanitizeText(channel.title),
      description: sanitizeText(channel.description),
      thumb: httpsUrl(findThumbnail(channel)),
      updated_at: new Date(),
      author: sanitizeText(channel["itunes:author"]) || null,
      language: sanitizeText(channel.language) || null,
      explicit: parseExplicit(channel["itunes:explicit"]),
      website: link,
      categories: parseCategories(channel["itunes:category"]),
      tags: null,
    };
  }

  if (xml.RDF) {
    const channel = xml.RDF.channel;
    const link = httpsUrl(channel.link);
    return {
      channel_id: generateChannelId(channel.link),
      rss: link!,
      title: sanitizeText(channel.title),
      description: sanitizeText(channel.description),
      thumb: httpsUrl(findThumbnail(channel)),
      updated_at: new Date(),
      author: sanitizeText(channel["dc:creator"]) || null,
      language: sanitizeText(channel["dc:language"]) || null,
      explicit: null,
      website: link,
      categories: null,
      tags: null,
    };
  }

  throw new Error("Unsupported feed format");
}
