import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import sharp from "sharp";
import { pgtemp } from "@surprisetalk/pgtemp";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { boot, NO_DB, ROOT, serve, stallingUpstream } from "./server.harness.ts";

const RACE_MS = 5_000;

// One pgtemp serves the file, as in functions/test.ts: a pgtemp boot takes about 1 s, and the server tests ran 3 of them.
const pg = await pgtemp({ extensions: { pg_trgm }, setup: await Deno.readTextFile(`${ROOT}/db.sql`) });
// pgtemp rejects prepared statements. postgres.js reads its options from the URL query too.
const PG_ENV = { DATABASE_URL: `${pg.url}?prepare=false` };

// Each test starts with no channels. The last one to finish closes pgtemp, as in functions/test.ts.
let dbTestsLeft = 0;
function dbTest(name: string, fn: () => Promise<void>) {
  dbTestsLeft++;
  Deno.test(name, async () => {
    try {
      await pg.sql`delete from channel`;
      await fn();
    } finally {
      if (--dbTestsLeft === 0) await pg.close();
    }
  });
}

Deno.test("server: serves the app, app routes, and a resized thumb, and with no database /search and /feeds.json answer 500", async () => {
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#00f" } }).png().toBuffer();
  const server = await boot(NO_DB);
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }),
  );
  try {
    const base = server.base;
    const index = await Deno.readTextFile(`${ROOT}/public/index.html`);
    for (const path of ["/", "/episode/x", "/remix?src=http%3A%2F%2Fa.example%2Fa.mp4&t=1,2"]) {
      const res = await fetch(base + path);
      assertEquals([path, res.status, await res.text()], [path, 200, index]);
    }
    // iOS and Android install the app from these: the page links both, and each icon is served at the size the manifest declares.
    assertStringIncludes(index, '<link rel="manifest" href="/manifest.json" />');
    assertStringIncludes(index, '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    const manifest = await (await fetch(`${base}/manifest.json`)).json();
    const icons = [...manifest.icons, { src: "/apple-touch-icon.png", sizes: "180x180" }];
    for (const { src, sizes } of icons) {
      const res = await fetch(base + src);
      const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
      assertEquals([src, res.status, `${meta.width}x${meta.height}`], [src, 200, sizes]);
    }
    const css = await fetch(`${base}/style.css`);
    assertEquals([css.status, css.headers.get("content-type")], [200, "text/css; charset=UTF-8"]);
    await css.body?.cancel();
    for (const path of ["/proxy/thumb/%E0%A4%A", "/proxy/rss/%E0%A4%A", "/%E0%A4%A"]) {
      const res = await fetch(base + path);
      assertEquals([path, res.status, await res.text()], [
        path,
        400,
        `Expected a valid percent-encoded path, received ${path}. Encode the URL with encodeURIComponent.`,
      ]);
    }
    const nul = await fetch(`${base}/%00`);
    assertEquals([nul.status, await nul.text()], [400, "Expected a path with no %00, received /%00."]);
    // A segment over the file system's 255-byte name limit made Deno's stat throw, and serveDir answered 500.
    const long = await fetch(`${base}/${"a".repeat(300)}.js`);
    assertEquals([long.status, await long.text()], [404, "Not Found"]);
    const missing = await fetch(`${base}/missing.js`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const search = await fetch(`${base}/search?q=rust`);
    assertEquals(search.status, 500);
    assertStringIncludes(await search.text(), "Search failed");
    const feeds = await fetch(`${base}/feeds.json`);
    assertEquals([feeds.status, await feeds.text()], [
      500,
      "Feeds failed. Expected the channel table to answer. Check that postgres is up.",
    ]);

    const thumbUrl = `http://127.0.0.1:${upstream.addr.port}/art.png`;
    const thumb = await fetch(`${base}/proxy/thumb/${encodeURIComponent(thumbUrl)}`);
    assertEquals(thumb.headers.get("content-type"), "image/webp");
    const meta = await sharp(new Uint8Array(await thumb.arrayBuffer())).metadata();
    assertEquals([meta.format, meta.width], ["webp", 256]);
  } finally {
    await server.stop();
    await upstream.shutdown();
  }
});

Deno.test("server: exits nonzero and names DATABASE_URL when it is missing", async () => {
  const child = serve({});
  const [status, stderr] = await Promise.all([child.status, new Response(child.stderr).text()]);
  assertEquals(status.success, false);
  assertStringIncludes(stderr, "DATABASE_URL is missing");
});

dbTest(
  "server: on SIGTERM an idle server drains at once with its database connection open, and a busy one cuts its open response",
  async () => {
    const release = Promise.withResolvers<void>();
    const up = stallingUpstream(release.promise);
    // Both run at once: the busy server waits out its grace period, and the idle one needs none of it.
    const [idle, busy] = await Promise.all([boot(PG_ENV), boot(NO_DB)]);
    try {
      const res = await fetch(`${idle.base}/search?q=rust`).catch((e) => {
        throw new Error(`Expected /search to answer, received ${e}. stderr: ${idle.log()}`);
      });
      assertEquals(res.status, 200, await res.text());
      // The feed proxy waits for the upstream to finish, so this response stays open, as one to a /feeds.json client that stops reading does.
      // Settled at once, so a slow stop reports its own error and not this fetch's rejection.
      const held = fetch(`${busy.base}/proxy/rss/${encodeURIComponent(up.url(0, 0))}`).then(
        async (res) => `answered ${res.status}: ${await res.text()}`,
        (e: unknown) => e,
      );
      await up.sentAll(1);
      await Promise.all([idle.stop(), busy.stop()]);
      // The grace exit also ends a process within the stop bound, so only its absent line shows that sql.end() let the idle loop drain.
      assertEquals(
        idle.log().includes("Exiting cuts them."),
        false,
        `Expected the idle server to exit by draining, received the grace exit. stderr: ${idle.log()}`,
      );
      assertStringIncludes(busy.log(), "received some still open. Exiting cuts them.");
      assertInstanceOf(await held, TypeError);
    } finally {
      release.resolve();
      await Promise.all([idle.stop(), busy.stop()]);
      await up.server.shutdown();
    }
  },
);

dbTest("server: /feeds.json streams the rss URLs as one sorted JSON array, distinct, in byte order", async () => {
  const server = await boot(PG_ENV);
  try {
    const empty = await fetch(`${server.base}/feeds.json`);
    assertEquals([empty.status, empty.headers.get("content-type"), await empty.text()], [200, "application/json", "[]"]);
    // 12,000 rows span three cursor batches. "B" (0x42) sorts before "b" (0x62) in byte order. The quote and backslash test escaping.
    const urls = Array.from({ length: 12_000 }, (_, i) => `https://x.example/${String(i).padStart(5, "0")}"q\\`);
    urls.push("https://x.example/b", "https://x.example/B");
    await pg
      .sql`insert into channel (channel_id, rss, title) select 'c' || i, u, 't' from unnest(${urls}::text[]) with ordinality as t(u, i)`;
    // A second channel with an existing URL must not repeat it.
    await pg.sql`insert into channel (channel_id, rss, title) values ('dup', ${urls[0]}, 't')`;
    const res = await fetch(`${server.base}/feeds.json`);
    const body = await res.text();
    assertEquals(res.status, 200);
    const want = [...urls].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    assertEquals(body, JSON.stringify(want));
    assertEquals(await (await fetch(`${server.base}/feeds.json`)).text(), body);
  } finally {
    await server.stop();
  }
});

dbTest("server: /feeds.json serves one reader at a time, and a reader that leaves before its first byte frees the guard", async () => {
  const server = await boot(PG_ENV);
  try {
    const urls = ["https://x.example/a", "https://x.example/b"];
    await pg
      .sql`insert into channel (channel_id, rss, title) select 'c' || i, u, 't' from unnest(${urls}::text[]) with ordinality as t(u, i)`;
    // pgtemp is one Postgres session, so an open transaction makes every other connection wait. The request that enters first takes
    // the guard and waits for the database, so the first answer must be the other's 503. A stall by body size instead depends on how
    // much the kernel buffers for a client that does not read: about 4.5 MB on pc.
    const tx = await pg.sql.reserve();
    let open = false;
    try {
      await tx`begin`;
      open = true;
      const aborts = [new AbortController(), new AbortController()];
      const requests = aborts.map((a) => fetch(`${server.base}/feeds.json`, { signal: a.signal }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) =>
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Expected one of two /feeds.json requests to answer 503 while the other waits, received no answer in ${RACE_MS} ms.`,
              ),
            ),
          RACE_MS,
        )
      );
      const first = await Promise.race([...requests.map((p, i) => p.then((res) => ({ res, i }))), late]).finally(() => clearTimeout(timer));
      assertEquals([first.res.status, await first.res.text()], [
        503,
        "Busy. Expected one /feeds.json reader at a time. Retry in a minute.",
      ]);
      aborts[1 - first.i].abort();
      await assertRejects(() => requests[1 - first.i], DOMException);
      await tx`commit`;
      open = false;
    } finally {
      // A failed assertion leaves tx in its transaction, and pgtemp then makes every other connection wait without bound.
      if (open) await tx`rollback`;
      tx.release();
    }
    let res = await fetch(`${server.base}/feeds.json`);
    for (let tries = 1; tries < 50 && res.status === 503; tries++) {
      await res.body!.cancel();
      await new Promise((r) => setTimeout(r, 20));
      res = await fetch(`${server.base}/feeds.json`);
    }
    assertEquals([res.status, await res.text()], [200, JSON.stringify(urls)], `stderr: ${server.log()}`);
    // The generator's finally runs before the stream closes, so a request after a full read never sees 503.
    const after = await fetch(`${server.base}/feeds.json`);
    assertEquals([after.status, await after.text()], [200, JSON.stringify(urls)]);
  } finally {
    await server.stop();
  }
});
