import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import sharp from "sharp";

const SERVER = `${import.meta.dirname}/server.ts`;
const START_TIMEOUT_MS = 20_000;
// Port 1 refuses connections, so /search reaches postgres.js and fails without a database.
const NO_DB = "postgres://telecast:x@127.0.0.1:1/telecast";

function serve(env: Record<string, string>) {
  return new Deno.Command(Deno.execPath(), {
    // The cwd is a temp dir for cache/, so --config points Deno at the repo for package.json imports.
    args: ["serve", "-A", `--config=${import.meta.dirname}/deno.json`, "--host=127.0.0.1", "--port=0", SERVER],
    cwd: Deno.makeTempDirSync(),
    clearEnv: true,
    env: { HOME: Deno.env.get("HOME")!, PATH: Deno.env.get("PATH")!, ...env },
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
  const child = serve({ DATABASE_URL: NO_DB });
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
    const index = await Deno.readTextFile(`${import.meta.dirname}/public/index.html`);
    for (const path of ["/", "/episode/x"]) {
      const res = await fetch(base + path);
      assertEquals([path, res.status, await res.text()], [path, 200, index]);
    }
    const css = await fetch(`${base}/style.css`);
    assertEquals([css.status, css.headers.get("content-type")], [200, "text/css; charset=UTF-8"]);
    await css.body?.cancel();
    for (const path of ["/proxy/thumb/%E0%A4%A", "/proxy/rss/%E0%A4%A", "/%E0%A4%A", "/%00"]) {
      const res = await fetch(base + path);
      assertEquals([path, res.status, await res.text()], [
        path,
        400,
        `Expected a percent-encoded path with no %00, received ${path}. Encode the URL with encodeURIComponent.`,
      ]);
    }
    const missing = await fetch(`${base}/missing.js`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const search = await fetch(`${base}/search?q=rust`);
    assertEquals(search.status, 502);
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
