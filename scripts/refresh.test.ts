import { assertEquals, assertRejects } from "@std/assert";
import { pgtemp } from "@surprisetalk/pgtemp";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { type Due, refreshChannels } from "./refresh.ts";
import { pool } from "./pool.ts";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Good</title><link>https://good.example.org/</link>
<item><title>One</title><guid>g1</guid><enclosure url="https://good.example.org/1.mp3" type="audio/mpeg" length="1"/></item></channel></rss>`;

const ytRss = (i: number) => `https://www.youtube.com/feeds/videos.xml?channel_id=UC${String(i).padStart(22, "0")}`;
const ytRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `yt${i}`, rss: ytRss(i) }));

Deno.test("refreshChannels", async (t) => {
  await using pg = await pgtemp({
    extensions: { pg_trgm },
    setup: await Deno.readTextFile(new URL("../db.sql", import.meta.url)),
  });

  async function seedRows(rows: { id: string; rss: string }[]) {
    await pg.sql`truncate channel, episode`;
    for (const r of rows) await pg.sql`insert into channel (channel_id, rss, title) values (${r.id}, ${r.rss}, ${r.id})`;
    return await pg.sql<Due[]>`select channel_id, rss, consecutive_errors from channel order by channel_id`;
  }

  // The UULF HEAD probe answers 404, so the feed URL stays in the channel_id form. No test touches the network.
  const fakeFetch = (answer: (url: string) => Response): typeof fetch => (input, init) =>
    Promise.resolve(init?.method === "HEAD" ? new Response(null, { status: 404 }) : answer(String(input)));

  const state = async (id: string) =>
    (await pg.sql`select last_error_at, last_error, consecutive_errors, last_success_at from channel where channel_id = ${id}`)[0]!;

  await t.step("a blocked host does not mark its channels as failed", async () => {
    const yt = ytRows(20);
    const rows = await seedRows([...yt, { id: "good", rss: "https://good.example.org/feed" }, {
      id: "dead",
      rss: "https://dead.example.org/feed",
    }]);
    const before = (await pg.sql`select now() as t`)[0]!.t;
    await refreshChannels(
      pg.sql,
      fakeFetch((url) =>
        url.includes("youtube.com")
          ? new Response("no", { status: Number(url.at(-1)) % 4 === 0 ? 500 : 404 })
          : url.includes("good.")
          ? new Response(RSS)
          : new Response("no", { status: 404 })
      ),
      rows,
    );
    for (const r of yt) {
      const s = await state(r.id);
      assertEquals([s.last_error_at, s.consecutive_errors], [null, 0], r.id);
    }
    assertEquals((await state("dead")).last_error, "HTTP 404");
    const moved = await pg.sql`select channel_id from channel where updated_at > ${before} and channel_id like 'yt%'`;
    assertEquals(moved.length, 20, "skipped rows move to the back of the queue");
    assertEquals((await state("good")).last_success_at !== null, true);
  });

  await t.step("a host with few HTTP errors still marks them", async () => {
    const yt = ytRows(20);
    const rows = await seedRows(yt);
    const bad = new Set(yt.slice(0, 5).map((r) => r.rss));
    await refreshChannels(pg.sql, fakeFetch((url) => bad.has(url) ? new Response("no", { status: 404 }) : new Response(RSS)), rows);
    const failed = await pg.sql`select channel_id from channel where last_error_at is not null order by channel_id`;
    assertEquals(failed.map((r) => r.channel_id), ["yt0", "yt1", "yt2", "yt3", "yt4"]);
  });

  await t.step("a blocked host still marks timeouts and parse errors", async () => {
    const yt = ytRows(20);
    const rows = await seedRows(yt);
    await refreshChannels(
      pg.sql,
      fakeFetch((url) => url.endsWith("0000") || url.endsWith("1") ? new Response("<not-a-feed/>") : new Response("no", { status: 500 })),
      rows,
    );
    const failed = await pg.sql`select channel_id, last_error from channel where last_error_at is not null`;
    assertEquals(failed.length > 0 && failed.every((r) => !String(r.last_error).startsWith("HTTP ")), true);
  });

  await t.step("429 never marks a channel", async () => {
    const rows = await seedRows([{ id: "a", rss: "https://a.example.org/feed" }]);
    await refreshChannels(pg.sql, fakeFetch(() => new Response("slow down", { status: 429 })), rows);
    assertEquals((await state("a")).last_error_at, null);
  });

  await t.step("an unparsable feed URL marks its channel and spares the rest", async () => {
    // The schema only requires the prefix `https://`, so `https://` alone is a legal row.
    const rows = await seedRows([{ id: "bad", rss: "https://" }, { id: "good", rss: "https://good.example.org/feed" }]);
    // Like the real fetch, the fake throws on an unparsable URL.
    const strict = fakeFetch((url) => (URL.canParse(url) ? new Response(RSS) : (() => {
      throw new TypeError("Invalid URL");
    })()));
    await refreshChannels(pg.sql, strict, rows);
    assertEquals((await state("bad")).last_error_at !== null, true);
    assertEquals((await state("good")).last_success_at !== null, true);
  });

  await t.step("a feed with a repeated guid refreshes and spares the rest", async () => {
    // One INSERT ... ON CONFLICT cannot touch the same row twice, so a repeated guid made postgres reject the whole run.
    const item =
      `<item><title>Dup</title><guid>g1</guid><enclosure url="https://dup.example.org/1.mp3" type="audio/mpeg" length="1"/></item>`;
    const rows = await seedRows([{ id: "dup", rss: "https://dup.example.org/feed" }, { id: "good", rss: "https://good.example.org/feed" }]);
    await refreshChannels(
      pg.sql,
      fakeFetch((url) => url.includes("dup.") ? new Response(RSS.replace("</channel>", item + item + "</channel>")) : new Response(RSS)),
      rows,
    );
    assertEquals((await state("dup")).last_success_at !== null, true);
    assertEquals((await state("good")).last_success_at !== null, true);
    assertEquals((await pg.sql`select count(*)::int as n from episode where channel_id = 'dup'`)[0]!.n, 1);
  });

  await t.step("feed content that breaks a db.sql constraint marks its channel and spares the rest", async () => {
    // Each bad feed once made postgres reject the whole run, and its channel was picked again by every later run.
    const item = (x: string) => RSS.replace("</item>", x + "</item>");
    const nul = "\u0000";
    const bad: Record<string, [string, string]> = {
      durationTooBig: [item("<itunes:duration>99999999999</itunes:duration>"), "duration_seconds"],
      durationInfinity: [item("<itunes:duration>Infinity</itunes:duration>"), "duration_seconds"],
      seasonTooBig: [item("<itunes:season>99999999999</itunes:season>"), "season"],
      episodeTooBig: [item("<itunes:episode>3000000000</itunes:episode>"), "episode"],
      sizeTooBig: [
        RSS.replace('length="1"', 'length="99999999999999999999"'),
        "src_size_bytes",
      ],
      dateTooFar: [item("<pubDate>+275760-09-13T00:00:00Z</pubDate>"), "published_at"],
      dateYearZero: [item("<pubDate>0000-01-01T00:00:00Z</pubDate>"), "published_at"],
      nulTitle: [RSS.replace("<title>One</title>", `<title>a${nul}b</title>`), "title"],
      nulSrcType: [RSS.replace("audio/mpeg", `au${nul}dio`), "src_type"],
      nulChannelTitle: [RSS.replace("<title>Good</title>", `<title>a${nul}b</title>`), "title"],
      nulLanguage: [RSS.replace("</title><link>", `</title><language>e${nul}n</language><link>`), "language"],
      nulCategory: [RSS.replace("</title><link>", `</title><itunes:category text="a${nul}b"/><link>`), "categories"],
      objectThumb: [RSS.replace("</title><link>", "</title><image><url><a>x</a></url></image><link>"), "URL string"],
    };
    const ok: Record<string, string> = {
      okFloat: item("<itunes:duration>1.5</itunes:duration>"),
      okLong: item(`<description>${Array.from({ length: 200_000 }, (_, i) => "w" + i.toString(36) + "x").join(" ")}</description>`),
      okArray: item("<itunes:explicit>yes</itunes:explicit><itunes:explicit>no</itunes:explicit>"),
      good: RSS,
    };
    const rows = await seedRows([...Object.keys(bad), ...Object.keys(ok)].map((id) => ({ id, rss: `https://h.example.org/${id}` })));
    await refreshChannels(pg.sql, fakeFetch((url) => new Response(bad[url.split("/").at(-1)!]?.[0] ?? ok[url.split("/").at(-1)!])), rows);
    for (const [id, [, field]] of Object.entries(bad)) {
      const s = await state(id);
      assertEquals(s.consecutive_errors, 1, id);
      assertEquals(String(s.last_error).includes(field), true, `${id}: ${s.last_error}`);
    }
    for (const id of Object.keys(ok)) assertEquals((await state(id)).last_success_at !== null, true, id);
    assertEquals((await pg.sql`select duration_seconds from episode where channel_id = 'okFloat'`)[0]!.duration_seconds, 2);
    assertEquals((await pg.sql`select explicit from episode where channel_id = 'okArray'`)[0]!.explicit, true);
  });

  await t.step("a database error rejects the run", async () => {
    const rows = await seedRows([{ id: "good", rss: "https://good.example.org/feed" }]);
    await pg.sql`alter table channel add constraint no_good check (title <> 'Good')`;
    await assertRejects(() => refreshChannels(pg.sql, fakeFetch(() => new Response(RSS)), rows), Error, "no_good");
  });
});

Deno.test("pool rejects on the first worker error", async () => {
  await assertRejects(
    () => pool([1, 2, 3], 2, (n) => n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve()),
    Error,
    "boom",
  );
});
