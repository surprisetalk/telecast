import { assertEquals, assertRejects } from "jsr:@std/assert";
import { pgtemp } from "jsr:@surprisetalk/pgtemp@0.2.7";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import db from "postgres";
import { parse, parseEpisodes } from "../functions/_shared/rss.ts";
import {
  archiveFeedUrls,
  extractYoutubeLinks,
  fromGithub,
  gather,
  GITHUB_MAX_BYTES,
  GITHUB_PER_RUN,
  linksFromGithubCsv,
  linksFromHnHits,
  linksFromLectures,
  seedChannel,
} from "./seed.ts";

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

Deno.test("gather: a source that throws fails the run, naming each; 0 links only warns", async () => {
  const ok = () => Promise.resolve(["https://www.youtube.com/@a"]);
  assertEquals(await gather([["hn", ok], ["lectures", () => Promise.resolve([])]]), ["https://www.youtube.com/@a"]);
  const err = await assertRejects(() =>
    gather([["hn", ok], ["github", () => Promise.reject(new Error("HTTP 429"))], ["lectures", () => Promise.reject(new Error("bad json"))]])
  );
  const msg = (err as Error).message;
  for (const part of ["github: HTTP 429", "lectures: bad json"]) assertEquals(msg.includes(part), true, `${part} missing from: ${msg}`);
  const odd = await assertRejects(() => gather([["a", () => Promise.reject("str")], ["b", () => Promise.reject(null)]]));
  assertEquals((odd as Error).message.startsWith("Seed sources failed: a: str; b: null."), true, (odd as Error).message);
});

const fixture = (name: string) => Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("linksFromGithubCsv: reads ids from a recorded dataset excerpt, ignores descriptions", async () => {
  assertEquals(linksFromGithubCsv(await fixture("github-channels.csv")), [
    "https://www.youtube.com/channel/UCMdRkWIe9mdpsw4-8EID4rw",
    "https://www.youtube.com/channel/UCUsTSbCLD96-pcWi2Kqaitg",
    "https://www.youtube.com/channel/UCyCyTe_1bT2aIPwG_gxbyeg",
  ]);
  assertEquals(linksFromGithubCsv("id,url,description\n"), []);
});

Deno.test("fromGithub: samples at most GITHUB_PER_RUN channels, and refuses a body over the cap", async () => {
  const big = "id,url,description\n" +
    Array.from({ length: 500 }, (_, i) => {
      const id = "UC" + String(i).padStart(22, "0");
      return `${id},https://www.youtube.com/channel/${id},d`;
    }).join("\n");
  const got = await fromGithub(() => Promise.resolve(new Response(big)));
  assertEquals(got.length, GITHUB_PER_RUN);
  assertEquals(new Set(got).size, GITHUB_PER_RUN);
  await assertRejects(() => fromGithub(() => Promise.resolve(new Response("x".repeat(GITHUB_MAX_BYTES + 1)))), Error, "bytes");
  await assertRejects(() => fromGithub(() => Promise.resolve(new Response("nope", { status: 404 }))), Error, "HTTP 404");
});

Deno.test("archive feeds: recorded collection RSS parses to episodes with playable https enclosures", async () => {
  assertEquals(archiveFeedUrls().every((u) => /^https:\/\/archive\.org\/services\/collection-rss\.php\?collection=[\w-]+$/.test(u)), true);
  for (const name of ["archive-oldtimeradio.xml", "archive-prelinger.xml"]) {
    const xml = await fixture(name);
    const channel = parse(xml, "https://archive.org/services/collection-rss.php?collection=x");
    const eps = parseEpisodes(xml, channel.channel_id);
    assertEquals(eps.length, 3);
    for (const e of eps) {
      assertEquals(/^https:\/\/archive\.org\/download\//.test(e.src ?? ""), true, `${name}: ${e.src}`);
      assertEquals(/^(audio|video)\//.test(e.src_type ?? ""), true);
    }
  }
});

Deno.test("seedChannel: inserts the feed url as rss, tags it, and adds tags to a channel seeded earlier", async () => {
  await using pg = await pgtemp({ extensions: { pg_trgm }, setup: await Deno.readTextFile(new URL("../db.sql", import.meta.url)) });
  const feed = "https://archive.org/services/collection-rss.php?collection=oldtimeradio";
  const xml = await fixture("archive-oldtimeradio.xml");
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(xml));
  const sql = db(pg.url, { prepare: false, onnotice: () => {} });
  try {
    const row = () => sql`select rss, tags from channel`;
    assertEquals((await seedChannel(sql, feed, false, [])).status, "inserted");
    assertEquals((await row())[0]!.tags, null);
    assertEquals((await row())[0]!.rss, feed);
    // Same channel again with a tag: the old row gains it.
    assertEquals((await seedChannel(sql, feed, false, ["lectures"])).status, "exists");
    assertEquals((await row())[0]!.tags, ["lectures"]);
    assertEquals((await seedChannel(sql, feed, false, ["lectures"])).status, "exists");
    assertEquals((await row())[0]!.tags, ["lectures"]);
  } finally {
    globalThis.fetch = realFetch;
    await sql.end();
  }
});
