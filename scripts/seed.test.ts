import { assertEquals } from "jsr:@std/assert";
import { extractYoutubeLinks, linksFromHnHits, linksFromLectures, linksFromRedditListing } from "./seed.ts";

Deno.test("extractYoutubeLinks: pulls channel/handle/c/user forms, ignores videos", () => {
  const text = `
    check out https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg and
    https://youtube.com/@SomeHandle_1 plus http://m.youtube.com/c/LegacyCustom
    and https://www.youtube.com/user/OldSchool — but NOT
    https://www.youtube.com/watch?v=dQw4w9WgXcQ nor https://youtu.be/abc123
  `;
  assertEquals(extractYoutubeLinks(text), [
    "https://www.youtube.com/channel/UCdBXOyqr8cDshsp7kcKDAkg",
    "https://www.youtube.com/@SomeHandle_1",
    "https://www.youtube.com/c/LegacyCustom",
    "https://www.youtube.com/user/OldSchool",
  ]);
});

Deno.test("extractYoutubeLinks: strips trailing punctuation and dedups", () => {
  const text = `(https://www.youtube.com/@foo), see https://www.youtube.com/@foo. again [https://www.youtube.com/@foo]`;
  assertEquals(extractYoutubeLinks(text), ["https://www.youtube.com/@foo"]);
});

Deno.test("extractYoutubeLinks: garbage in → empty out", () => {
  assertEquals(extractYoutubeLinks(""), []);
  assertEquals(extractYoutubeLinks("no links here, just prose about youtube.com in general"), []);
});

Deno.test("linksFromHnHits: reads url/title/story_text/comment_text, tolerates nulls", () => {
  const hits = [
    { url: "https://www.youtube.com/@storyChannel", title: null },
    { title: "loved https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa", url: "https://news.example.com" },
    { comment_text: "mirror at https://m.youtube.com/user/prof", story_text: null },
    { url: 42 },
    "not an object",
  ];
  assertEquals(linksFromHnHits(hits), [
    "https://www.youtube.com/@storyChannel",
    "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
    "https://www.youtube.com/user/prof",
  ]);
  assertEquals(linksFromHnHits(null), []);
});

Deno.test("linksFromRedditListing: reads children url/title/selftext", () => {
  const json = {
    data: {
      children: [
        { data: { url: "https://www.youtube.com/@redditFind", title: "great channel", selftext: "" } },
        { data: { url: "https://reddit.com/r/x", selftext: "also https://www.youtube.com/c/Custom" } },
        { data: {} },
      ],
    },
  };
  assertEquals(linksFromRedditListing(json), [
    "https://www.youtube.com/@redditFind",
    "https://www.youtube.com/c/Custom",
  ]);
  assertEquals(linksFromRedditListing({}), []);
});

Deno.test("linksFromLectures: keeps http(s) urls verbatim, drops junk", () => {
  const json = [
    "https://www.youtube.com/@mitocw",
    "  https://example.edu/lectures/feed.xml  ",
    "not-a-url",
    42,
    "ftp://old/feed",
  ];
  assertEquals(linksFromLectures(json), [
    "https://www.youtube.com/@mitocw",
    "https://example.edu/lectures/feed.xml",
  ]);
  assertEquals(linksFromLectures("nope"), []);
});
