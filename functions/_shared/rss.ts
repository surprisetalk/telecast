import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function sanitizeText(text: string | null | undefined): string | null {
  if (!text) return null;

  // Handle CDATA or object values
  if (typeof text === "object") {
    text = (text as any)["#text"] || String(text);
  }

  // Remove HTML tags
  text = text.replace(/<[^>]*>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

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
    const image = contents.find((c) => c["@_medium"] === "image" || c["@_type"]?.startsWith("image/"));
    if (image?.["@_url"]) return image["@_url"];
  }

  // Try enclosure with image type
  const enclosure = item.enclosure;
  if (enclosure?.["@_type"]?.startsWith("image/") && enclosure["@_url"]) {
    return enclosure["@_url"];
  }

  return null;
}

export function parseEpisodes(xmlText: string, channelId: string) {
  const xml = parser.parse(xmlText);

  // Extract items from RSS/Atom/RDF
  let items: any[] = [];
  if (xml.feed?.entry) {
    items = Array.isArray(xml.feed.entry) ? xml.feed.entry : [xml.feed.entry];
  } else if (xml.rss?.channel?.item) {
    items = Array.isArray(xml.rss.channel.item) ? xml.rss.channel.item : [xml.rss.channel.item];
  } else if (xml.RDF?.item) {
    items = Array.isArray(xml.RDF.item) ? xml.RDF.item : [xml.RDF.item];
  }

  return items.slice(0, 50).map((item) => {
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

export function parse(xmlText) {
  function parseRss2Feed(channel) {
    return {
      channel_id: generateChannelId(channel.link),
      rss: channel.link,
      title: sanitizeText(channel.title),
      description: sanitizeText(channel.description),
      thumb: findThumbnail(channel),
      updated_at: new Date(),
    };
  }

  function parseAtomFeed(feed) {
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

  function parseRdfFeed(rdf) {
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

  function findThumbnail(channel) {
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

  function findAtomThumbnail(feed) {
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

  function generateChannelId(url) {
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
    // Atom
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
