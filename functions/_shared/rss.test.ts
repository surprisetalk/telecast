import { assertEquals } from "jsr:@std/assert";
import { parse, parseEpisodes } from "./rss.ts";

const channelFormXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>UCabc123</yt:channelId>
  <title>Channel Form Feed</title>
  <author><name>x</name><uri>https://www.youtube.com/channel/UCabc123</uri></author>
  <entry>
    <id>yt:video:v1</id>
    <yt:videoId>v1</yt:videoId>
    <yt:channelId>UCabc123</yt:channelId>
    <title>Real video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=v1"/>
    <published>2026-01-01T00:00:00Z</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/v1/hq.jpg"/></media:group>
  </entry>
</feed>`;

const playlistFormXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <yt:playlistId>UULFabc123</yt:playlistId>
  <title>Playlist Form Feed</title>
  <author><name>x</name><uri>https://www.youtube.com/channel/UCabc123</uri></author>
  <entry>
    <id>yt:video:v1</id>
    <yt:videoId>v1</yt:videoId>
    <yt:channelId>UCabc123</yt:channelId>
    <title>Real video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=v1"/>
    <published>2026-01-01T00:00:00Z</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/v1/hq.jpg"/></media:group>
  </entry>
</feed>`;

Deno.test("parse: channel-form and playlist-form yield the same channel_id", () => {
  const a = parse(channelFormXml);
  const b = parse(playlistFormXml);
  assertEquals(a.channel_id, "youtube.com/channel/UCabc123");
  assertEquals(b.channel_id, "youtube.com/channel/UCabc123");
});

Deno.test("parse: sourceUrl is stored in rss field for YouTube channels", () => {
  const url = "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFabc123";
  const c = parse(playlistFormXml, url);
  assertEquals(c.rss, url);
});

Deno.test("parse: omitting sourceUrl falls back to author URI for YouTube channels", () => {
  const c = parse(playlistFormXml);
  assertEquals(c.rss, "https://www.youtube.com/channel/UCabc123");
});

Deno.test("parseEpisodes: playlist-form feed yields episodes with given channel_id", () => {
  const eps = parseEpisodes(playlistFormXml, "youtube.com/channel/UCabc123");
  assertEquals(eps.length, 1);
  assertEquals(eps[0]!.channel_id, "youtube.com/channel/UCabc123");
  assertEquals(eps[0]!.episode_id, "v1");
  assertEquals(eps[0]!.title, "Real video");
  assertEquals(eps[0]!.link, "https://www.youtube.com/watch?v=v1");
});

Deno.test("parseEpisodes: feed with neither yt:channelId nor yt:playlistId at root falls back to entry-level yt:channelId", () => {
  const xml =
    `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><title>x</title><entry><id>1</id><yt:videoId>v</yt:videoId><yt:channelId>UCfromentry</yt:channelId><title>t</title><link rel="alternate" href="https://y"/><published>2026-01-01T00:00:00Z</published></entry></feed>`;
  const eps = parseEpisodes(xml, "youtube.com/channel/UCfromentry");
  assertEquals(eps.length, 1);
  assertEquals(eps[0]!.episode_id, "v");
});
