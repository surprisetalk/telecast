import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

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

  function sanitizeText(text) {
    if (!text) return null;

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

    return text;
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
