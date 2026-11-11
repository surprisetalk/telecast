import { assertEquals, assertInstanceOf } from "@std/assert";
import sharp from "sharp";
import { BUDGET, BYTES_PER_PIXEL, withSlot } from "./budget.ts";
import { boot, NO_DB, stallingUpstream } from "../../server.harness.ts";

const wholeBudgetInPixels = Math.floor((BUDGET - 1) / BYTES_PER_PIXEL);

Deno.test("withSlot: a reserve that wakes after its handler returned adds nothing", async () => {
  const release = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  // The older request holds a little. The younger one takes the whole budget and keeps it until released.
  const orphan = Promise.withResolvers<Promise<unknown>>();
  const older = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(1000);
    hold.resolve();
    await release.promise;
    // Return while this reserve still waits for room, as a fetch timeout does.
    orphan.resolve(reservePixels(1000).catch((e) => e));
    return new Response("older");
  });
  await hold.promise;
  const younger = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels - 1500);
    release.resolve();
    // Wait until the older handler has returned, then free the budget the orphan reserve is waiting for.
    await orphan.promise;
    await new Promise((r) => setTimeout(r, 50));
    return new Response("younger");
  });
  const [olderRes, youngerRes] = await Promise.all([older, younger]);
  assertEquals([olderRes.status, youngerRes.status], [200, 200]);
  assertInstanceOf(await (await orphan.promise), Error);
  // Nothing is left over, so one request can take the whole budget.
  const whole = await withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels);
    return new Response("whole");
  });
  assertEquals(whole.status, 200);
});

Deno.test("withSlot: an older request that waits for room evicts a younger one, which answers 503 at its next reserve", async () => {
  const olderHolds = Promise.withResolvers<void>();
  const youngerHolds = Promise.withResolvers<void>();
  const older = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(1000);
    olderHolds.resolve();
    await youngerHolds.promise;
    // About 2000 pixels are free, so this waits for room.
    await reservePixels(4000);
    return new Response("older");
  });
  await olderHolds.promise;
  const younger = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels - 3000);
    youngerHolds.resolve();
    await new Promise((r) => setTimeout(r, 50));
    // One pixel fits in the free room. Only the eviction refuses it.
    await reservePixels(1);
    return new Response("younger");
  });
  const [olderRes, youngerRes] = await Promise.all([older, younger]);
  assertEquals([olderRes.status, youngerRes.status], [200, 503]);
});

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
  // The upstream holds each request until all 60 have arrived, so they are in flight together. A request that the budget refuses
  // never arrives, so after 5 s the upstream answers the rest and the count of 503s below names the failure.
  const all = Promise.withResolvers<void>();
  const bound = setTimeout(all.resolve, 5_000);
  let arrived = 0;
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (++arrived === 60) all.resolve();
    await all.promise;
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
    clearTimeout(bound);
    await server.stop();
    await upstream.shutdown();
  }
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
