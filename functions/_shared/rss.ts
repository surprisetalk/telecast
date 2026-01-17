import { XMLParser } from "fast-xml-parser";

export interface Channel {
  channel_id: string;
  rss: string;
  title: string | null;
  description: string | null;
  thumb: string | null;
  updated_at: Date;
}

export interface Episode {
  channel_id: string;
  episode_id: string;
  title: string;
  description: string | null;
  thumb: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function sanitizeText(text: any): string | null {
  if (!text) return null;

  // Handle arrays - take first element (fast-xml-parser returns arrays for duplicate tags)
  if (Array.isArray(text)) {
    text = text[0];
    if (!text) return null;
  }

  // Handle CDATA or object values
  if (typeof text === "object") {
    text = (text as any)["#text"] || String(text);
  }

  // Ensure we have a string
  if (typeof text !== "string") {
    text = String(text);
  }

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
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
  text = text.replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text || null;
}

function generateEpisodeId(item: any): string {
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

function findEpisodeThumbnail(item: any): string | null {
  // Try itunes:image
  if (item["itunes:image"]?.["@_href"]) {
    return item["itunes:image"]["@_href"];
  }

  // Try media:thumbnail
  if (item["media:thumbnail"]?.["@_url"]) {
    return item["media:thumbnail"]["@_url"];
  }

  // Try media:content with medium="image"
  const mediaContent = item["media:content"];
  if (mediaContent) {
    const contents = Array.isArray(mediaContent) ? mediaContent : [mediaContent];
    const image = contents.find(c => c["@_medium"] === "image" || c["@_type"]?.startsWith("image/"));
    if (image?.["@_url"]) return image["@_url"];
  }

  // Try enclosure with image type
  const enclosure = item.enclosure;
  if (enclosure?.["@_type"]?.startsWith("image/") && enclosure["@_url"]) {
    return enclosure["@_url"];
  }

  return null;
}

export function parseEpisodes(xmlText: string, channelId: string): Episode[] {
  const xml = parser.parse(xmlText);

  // Check for YouTube feed
  const ytChannelId = xml.feed?.["yt:channelId"];
  if (typeof ytChannelId === "string" && ytChannelId.startsWith("UC")) {
    const entries = xml.feed.entry;
    const items = Array.isArray(entries) ? entries : entries ? [entries] : [];
    return items.slice(0, 50).map((item: any) => {
      const thumb = item["media:group"]?.["media:thumbnail"]?.["@_url"];
      return {
        channel_id: channelId,
        episode_id: item["yt:videoId"] || generateEpisodeId(item),
        title: sanitizeText(item.title) || "Untitled",
        description: sanitizeText(item["media:group"]?.["media:description"]),
        thumb: thumb?.startsWith("https://") ? thumb : null,
      };
    });
  }

  // Extract items from RSS/Atom/RDF
  let items: any[] = [];
  if (xml.feed?.entry) {
    items = Array.isArray(xml.feed.entry) ? xml.feed.entry : [xml.feed.entry];
  } else if (xml.rss?.channel?.item) {
    items = Array.isArray(xml.rss.channel.item) ? xml.rss.channel.item : [xml.rss.channel.item];
  } else if (xml.RDF?.item) {
    items = Array.isArray(xml.RDF.item) ? xml.RDF.item : [xml.RDF.item];
  }

  return items.slice(0, 50).map(item => {
    const thumb = findEpisodeThumbnail(item);
    return {
      channel_id: channelId,
      episode_id: generateEpisodeId(item),
      title: sanitizeText(item.title) || "Untitled",
      description: sanitizeText(item.description || item.summary || item.content),
      thumb: thumb?.startsWith("https://") ? thumb : null,
    };
  });
}

export function parse(xmlText: string): Channel {
  function parseYouTubeFeed(feed: any): Channel {
    const channelId = feed["yt:channelId"];
    const authorUri = feed.author?.uri;
    return {
      channel_id: `youtube.com/channel/${channelId}`,
      rss: authorUri || `https://www.youtube.com/channel/${channelId}`,
      title: sanitizeText(feed.title),
      description: sanitizeText(feed.subtitle),
      thumb: null, // YouTube feed-level thumbnails aren't reliable
      updated_at: new Date(),
    };
  }

  function parseRss2Feed(channel: any): Channel {
    return {
      channel_id: generateChannelId(channel.link),
      rss: channel.link,
      title: sanitizeText(channel.title),
      description: sanitizeText(channel.description),
      thumb: findThumbnail(channel),
      updated_at: new Date(),
    };
  }

  function parseAtomFeed(feed: any): Channel {
    // Get primary link (rel="alternate" or first link)
    const link = Array.isArray(feed.link)
      ? feed.link.find(l => l["@_rel"] === "alternate")?.["@_href"] || feed.link[0]["@_href"]
      : feed.link["@_href"];

    return {
      channel_id: generateChannelId(link),
      rss: link,
      title: sanitizeText(feed.title),
      description: sanitizeText(feed.subtitle || feed.description),
      thumb: findAtomThumbnail(feed),
      updated_at: new Date(),
    };
  }

  function parseRdfFeed(rdf: any): Channel {
    const channel = rdf.channel;

    return {
      channel_id: generateChannelId(channel.link),
      rss: channel.link,
      title: sanitizeText(channel.title),
      description: sanitizeText(channel.description),
      thumb: findThumbnail(channel),
      updated_at: new Date(),
    };
  }

  function findThumbnail(channel: any): string | null {
    // Try standard RSS image
    if (channel.image?.url) {
      return channel.image.url;
    }

    // Try itunes:image
    if (channel["itunes:image"]?.["@_href"]) {
      return channel["itunes:image"]["@_href"];
    }

    // Try media:thumbnail
    if (channel["media:thumbnail"]?.["@_url"]) {
      return channel["media:thumbnail"]["@_url"];
    }

    return null;
  }

  function findAtomThumbnail(feed: any): string | null {
    // Try icon
    if (feed.icon) {
      return feed.icon;
    }

    // Try logo
    if (feed.logo) {
      return feed.logo;
    }

    // Try media:thumbnail
    if (feed["media:thumbnail"]?.["@_url"]) {
      return feed["media:thumbnail"]["@_url"];
    }

    return null;
  }

  function generateChannelId(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname + urlObj.pathname;
    } catch (e) {
      // If URL parsing fails, hash the original string
      return Buffer.from(url).toString("base64").slice(0, 32);
    }
  }

  const xml = parser.parse(xmlText);

  // Handle different feed formats
  if (xml.feed) {
    // Check for YouTube feed (yt:channelId starts with UC)
    const ytChannelId = xml.feed["yt:channelId"];
    if (typeof ytChannelId === "string" && ytChannelId.startsWith("UC")) {
      return parseYouTubeFeed(xml.feed);
    }
    // Standard Atom
    return parseAtomFeed(xml.feed);
  } else if (xml.rss) {
    // RSS 2.0
    return parseRss2Feed(xml.rss.channel);
  } else if (xml.RDF) {
    // RSS 1.0
    return parseRdfFeed(xml.RDF);
  }

  throw new Error("Unsupported feed format");
}
