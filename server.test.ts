import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import sharp from "sharp";
import { pgtemp } from "jsr:@surprisetalk/pgtemp@0.2.7";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const ROOT = import.meta.dirname!;
const START_TIMEOUT_MS = 20_000;
// pc's socket form. /run/postgresql/.s.PGSQL.5432 is missing here, so /search reaches postgres.js, which fails without a
// database, and Deno's permissions for the socket path get checked as on pc.
const NO_DB = { DATABASE_URL: "postgres:///telecast", PGHOST: "/run/postgresql", PGUSER: "telecast", PGPASSWORD: "x" };

// Starts the server with the flags of `deno task serve`, minus .env and on a free port, so the suite checks its permissions.
function serve(env: Record<string, string>) {
  const task: string = JSON.parse(Deno.readTextFileSync(`${ROOT}/deno.json`)).tasks.serve;
  const args = task.split(" ").slice(1).filter((a) => a !== "--env-file=.env").map((a) => a === "--port=8047" ? "--port=0" : a);
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: ROOT,
    clearEnv: true,
    // telecast-web on pc sets LD_LIBRARY_PATH, so sharp's addon finds libstdc++ on NixOS.
    env: { HOME: Deno.env.get("HOME")!, PATH: Deno.env.get("PATH")!, LD_LIBRARY_PATH: Deno.env.get("LD_LIBRARY_PATH") ?? "", ...env },
    stdout: "null",
    stderr: "piped",
  }).spawn();
}

Deno.test("server: serves the app, app routes, search, and a resized thumb", async () => {
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#00f" } }).png().toBuffer();
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }),
  );
  const child = serve(NO_DB);
  let log = "";
  const reading = (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) log += chunk;
  })();
  let exited = false;
  child.status.then(() => exited = true);
  try {
    const t0 = performance.now();
    let base: string | undefined;
    while (!base) {
      if (exited) throw new Error(`Server exited before it listened. stderr: ${log}`);
      if (performance.now() - t0 > START_TIMEOUT_MS) throw new Error(`Server did not listen within ${START_TIMEOUT_MS} ms. stderr: ${log}`);
      base = log.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      await new Promise((r) => setTimeout(r, 50));
    }
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

    const thumbUrl = `http://127.0.0.1:${upstream.addr.port}/art.png`;
    const thumb = await fetch(`${base}/proxy/thumb/${encodeURIComponent(thumbUrl)}`);
    assertEquals(thumb.headers.get("content-type"), "image/webp");
    const meta = await sharp(new Uint8Array(await thumb.arrayBuffer())).metadata();
    assertEquals([meta.format, meta.width], ["webp", 256]);
  } finally {
    if (!exited) child.kill();
    await child.status;
    await reading;
    await upstream.shutdown();
  }
});

Deno.test("server: exits nonzero and names DATABASE_URL when it is missing", async () => {
  const child = serve({});
  const [status, stderr] = await Promise.all([child.status, new Response(child.stderr).text()]);
  assertEquals(status.success, false);
  assertStringIncludes(stderr, "DATABASE_URL is missing");
});

// systemd waits 90 s after SIGTERM, then kills the unit. Until the server exits, cloudflared answers every visitor 502.
const STOP_TIMEOUT_MS = 5_000;

// Boots the server and returns its base URL, its stderr so far, and a stop function that sends SIGTERM as systemd does.
async function boot(env: Record<string, string>) {
  const child = serve(env);
  let log = "";
  const reading = (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) log += chunk;
  })();
  let exited = false;
  child.status.then(() => exited = true);
  const t0 = performance.now();
  let base: string | undefined;
  while (!base) {
    if (exited) throw new Error(`Server exited before it listened. stderr: ${log}`);
    if (performance.now() - t0 > START_TIMEOUT_MS) throw new Error(`Server did not listen within ${START_TIMEOUT_MS} ms. stderr: ${log}`);
    base = log.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    log: () => log,
    async stop() {
      const t0 = performance.now();
      if (!exited) child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await child.status;
      clearTimeout(kill);
      await reading;
      const ms = Math.round(performance.now() - t0);
      if (ms >= STOP_TIMEOUT_MS) {
        throw new Error(`Expected the server to exit within ${STOP_TIMEOUT_MS} ms of SIGTERM, received ${ms} ms. stderr: ${log}`);
      }
    },
  };
}

// Streams ?bytes= bytes of text in 100 KB chunks, counts the responses that sent all of them, then waits for release.
function stallingUpstream(release: Promise<void>) {
  const counter = { sent: 0 };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    let left = Number(new URL(req.url).searchParams.get("bytes"));
    const chunk = new TextEncoder().encode("x".repeat(100_000));
    return new Response(
      new ReadableStream({
        async pull(c) {
          if (left > 0) {
            left -= chunk.length;
            c.enqueue(chunk);
            return;
          }
          counter.sent++;
          await release;
          c.close();
        },
      }),
    );
  });
  const url = (i: number, bytes: number) => `http://127.0.0.1:${server.addr.port}/f${i}?bytes=${bytes}`;
  const sentAll = async (n: number) => {
    const t0 = performance.now();
    while (counter.sent < n) {
      if (performance.now() - t0 > 10_000) throw new Error(`Expected ${n} feeds fully sent, received ${counter.sent} after 10 s.`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { server, url, sentAll };
}

// 7 feeds of 40 MB reserve 7 x (1 MB + 40 MB x 6.22) = 1749 MB of the 1753 MB budget. One more feed of 0.4 MB takes 3.5 MB, which leaves
async function fillBudget(server: { base: string }, up: ReturnType<typeof stallingUpstream>) {
  const get = (url: string) => fetch(`${server.base}/proxy/rss/${encodeURIComponent(url)}`);
  const held = [...Array.from({ length: 7 }, (_, i) => get(up.url(i, 40e6))), get(up.url(7, 0.4e6))];
  await up.sentAll(8);
  // The proxy still holds the last chunks in flight when the upstream has sent them.
  await new Promise((r) => setTimeout(r, 300));
  return { get, held };
}

Deno.test("server: a request past the memory budget gets a 503 Busy and one busy: line each, and the slots free up after", async () => {
  const release = Promise.withResolvers<void>();
  const up = stallingUpstream(release.promise);
  const server = await boot(NO_DB);
  try {
    const { get, held } = await fillBudget(server, up);
    const busy = await get(up.url(8, 40e6));
    assertEquals(busy.status, 503);
    assertEquals(
      /^Busy: 8 feeds and thumbs are loading and use 175\d of 1753 MB\. Retry in a few seconds\.$/.test(await busy.text()),
      true,
    );
    // The YouTube resolver swallows the first rejection and fetches again. This request still logs one busy: line.
    const youtube = await get("https://www.youtube.com/channel/UCbusyprobe0000000000000");
    assertEquals(youtube.status, 503);
    await youtube.body?.cancel();
    release.resolve();
    const responses = await Promise.all(held);
    await Promise.all(responses.map((r) => r.body?.cancel()));
    assertEquals(responses.map((r) => r.status), Array(8).fill(400));
    const after = await get(up.url(9, 40e6));
    assertEquals(after.status, 400);
    await after.body?.cancel();
    assertEquals(server.log().split("\n").filter((l) => l.startsWith("busy:")).length, 2);
  } finally {
    release.resolve();
    await server.stop();
    await up.server.shutdown();
  }
});

Deno.test("server: 40 small thumbs and 20 small feeds in parallel are never Busy", async () => {
  const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#f80" } }).jpeg().toBuffer();
  const feed = `<rss><channel><title>t</title><!--${"x".repeat(100_000)}--></channel></rss>`;
  // Upstream waits, so all 60 requests are in flight together.
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    await new Promise((r) => setTimeout(r, 800));
    return req.url.includes("/thumb")
      ? new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } })
      : new Response(feed);
  });
  const server = await boot(NO_DB);
  try {
    const get = (kind: string, i: number) =>
      fetch(`${server.base}/proxy/${kind}/${encodeURIComponent(`http://127.0.0.1:${upstream.addr.port}/${kind}${i}`)}`);
    const all = [
      ...Array.from({ length: 40 }, (_, i) => get("thumb", i)),
      ...Array.from({ length: 20 }, (_, i) => get("rss", i)),
    ];
    const responses = await Promise.all(all);
    await Promise.all(responses.map((r) => r.body?.cancel()));
    assertEquals(responses.filter((r) => r.status === 503).length, 0);
    assertEquals(server.log().split("\n").filter((l) => l.startsWith("busy:")).length, 0);
  } finally {
    await server.stop();
    await upstream.shutdown();
  }
});

Deno.test("server: SIGTERM after a /search exits at once, with the database connection open", async () => {
  await using pg = await pgtemp({ extensions: { pg_trgm }, setup: await Deno.readTextFile(`${ROOT}/db.sql`) });
  // pgtemp rejects prepared statements. postgres.js reads its options from the URL query too.
  const server = await boot({ DATABASE_URL: `${pg.url}?prepare=false` });
  const res = await fetch(`${server.base}/search?q=rust`).catch((e) => {
    throw new Error(`Expected /search to answer, received ${e}. stderr: ${server.log()}`);
  });
  assertEquals(res.status, 200, await res.text());
  await server.stop();
});

Deno.test("server: 16 parallel 30 MB feeds staggered 5 ms apart: the oldest finish and only the youngest answer 503 Busy", async () => {
  // Every body starts when the last request has arrived, so all 16 bodies stream together and the arrival order stays 5 ms apart.
  // The upstream sends each body at 2 MB per 50 ms, so all 16 bodies grow at one rate on any machine. In CI, 16 unpaced 30 MB
  // bodies all finished with no request Busy.
  const arrived = Promise.withResolvers<void>();
  let hits = 0;
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
    if (++hits === 16) arrived.resolve();
    await arrived.promise;
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(out) {
          if (sent === 15) return out.close();
          await new Promise((r) => setTimeout(r, 50));
          out.enqueue(new Uint8Array(2e6).fill(120));
          sent++;
        },
      }, { highWaterMark: 0 }),
    );
  });
  const server = await boot(NO_DB);
  try {
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 16; i++) {
      pending.push(fetch(`${server.base}/proxy/rss/${encodeURIComponent(`http://127.0.0.1:${upstream.addr.port}/f${i}`)}`));
      await new Promise((r) => setTimeout(r, 5));
    }
    const responses = await Promise.all(pending);
    await Promise.all(responses.map((r) => r.body?.cancel()));
    const statuses = responses.map((r) => r.status);
    // 16 x 188 MB is 3 GB against a 1753 MB budget. The oldest finish (400: not a feed), and every request after the first Busy is Busy.
    const firstBusy = statuses.indexOf(503);
    assertEquals(firstBusy > 0 && firstBusy < 16, true, statuses.join(" "));
    assertEquals(statuses, statuses.map((_, i) => i < firstBusy ? 400 : 503));
    assertEquals(server.log().split("\n").filter((l) => l.startsWith("busy:")).length, 16 - firstBusy);
  } finally {
    await server.stop();
    await upstream.shutdown();
  }
});

Deno.test("server: a visitor-chosen URL with a newline cannot forge a busy: line", async () => {
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => new Response("gone", { status: 404 }));
  const server = await boot(NO_DB);
  try {
    const url = `http://127.0.0.1:${upstream.addr.port}/\nbusy: forged`;
    for (const kind of ["thumb", "rss"]) {
      const res = await fetch(`${server.base}/proxy/${kind}/${encodeURIComponent(url)}`);
      await res.body?.cancel();
    }
    const lines = server.log().split("\n");
    assertEquals(lines.some((l) => l.includes("forged")), true, server.log());
    assertEquals(lines.filter((l) => l.startsWith("busy:")), []);
  } finally {
    await server.stop();
    await upstream.shutdown();
  }
});
