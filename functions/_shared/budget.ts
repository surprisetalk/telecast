// Memory budget. telecast-web has MemoryMax=2G, and systemd kills it above that: the site is down for the 30 s RestartSec.
// Measured with `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 deno serve ...` on a scratch Postgres, 45 MB
// RSS items (/proxy/rss/ ?n=i, distinct upstream URLs) and a 25 MP, 11 MB PNG (/proxy/thumb/). VmHWM of the deno process, idle 0.10 GB:
//   rss, parallel 1 / 4 / 8 / 16 / 30 / 60: 0.52 / 1.04 / 1.50 / 1.60 / 2.65 / 3.1 GB. Past 8, the 15 s fetch timeout answers 500 for most.
//   thumb, parallel 1 / 4 / 8: 0.14 / 0.28 / 0.43 GB.
// 60 parallel feeds peak above 2 GB, so a cap is needed. Peak per request: 0.94 GB / 4 feeds, rounded up to 280 MB per 45 MB feed.
// 0.34 GB / 8 thumbs, rounded up to 50 MB per 25 MP, 11 MB image. With the budget below, VmHWM peaked at: 60 parallel 45 MB feeds
// 1.67 GB; 80 parallel 25 MP PNGs of 14.5 MB 1.74 GB; 60 feeds with 60 thumbs 1.13 GB. The kill line is 2.15 GB.
// Reproduce: run the serve task under the systemd-run scope above, serve the feed and the PNG from a local Deno.serve, fire N parallel
// requests, and read VmHWM in /proc/<pid>/status.
// REVIEW: The budget lives in budget.ts so a test can drive withSlot with a handler that outlives its reserve. Alternative: keep it in
// server.ts and test through HTTP. The only trigger is the 15 s fetch timeout, which makes the test too slow.
// REVIEW: One budget covers both proxies, and a request reserves what it holds as it holds it: bytes read times a measured factor,
// and for a thumb the decoded pixels. Alternative: weigh each request at its worst case up front. It is simpler, but 40 small thumbs
// then answer 503 Busy though they hold 4 MB. Cost: a reservation can fail mid-body, so the work so far is lost.
// REVIEW: Only requests that call fetch take a slot, so cache hits never get a 503. Alternative: wrap the whole handler. It also
// counts cache hits, and a library load of 30 cached feeds would 503. Cost: a cache hit on a 45 MB feed is not counted.
export const MB = 1e6;
// 10% headroom: 80 parallel thumbs peaked at 2.04 GB with the full 1948 MB, 2.5% under the kill line.
export const BUDGET = 0.9 * (2048 - 100) * MB;
// A request that has called fetch holds a socket and parser state.
const CONNECTION = 1 * MB;
// A feed of 45 MB peaked at 280 MB: the chunks, the joined copy, the decoded string, and the parse.
export const FEED_FACTOR = 280 / 45;
// A 25 MP, 11 MB PNG peaked at 50 MB. The chunks and the joined copy are 2 x 11 MB. The pixels are the rest.
export const THUMB_FACTOR = 2;
export const BYTES_PER_PIXEL = (50 - THUMB_FACTOR * 11) * MB / 25e6;
// A request that cannot reserve evicts the youngest request younger than itself and retries, so the oldest requests finish.
// Without it, 60 feeds that start together all stall at the budget and all answer 503.
const WAIT_MS = 10;
const WAIT_MAX = 100;
// running: the handler is working. evicted: a waiting older request took this one's turn, but the handler may still finish and keep its
// answer. refused: a reserve threw, so the handler did not finish. done: the handler returned, and a reserve that wakes now must add nothing.
type SlotState = { kind: "running" } | { kind: "evicted"; why: string } | { kind: "refused"; why: string } | { kind: "done" };
type Slot = { held: number; state: SlotState };
// Insertion order is arrival order.
const slots = new Set<Slot>();
let loadedBytes = 0;

const loadMessage = () =>
  `${slots.size} feeds and thumbs are loading and use ${Math.round(loadedBytes / MB)} of ${Math.round(BUDGET / MB)} MB`;

async function reserve(slot: Slot, bytes: number): Promise<void> {
  const need = Math.ceil(bytes);
  for (let waited = 0;; waited++) {
    const state = slot.state;
    // A reserve can wake after its handler returned (fetch timeout, readCapped cap, cancel). Adding then would leak the bytes.
    if (state.kind === "done") throw new Error("done");
    // The YouTube resolver swallows the first rejection and fetches again. A Busy request stays Busy and logs once.
    if (state.kind === "evicted" || state.kind === "refused") {
      slot.state = { kind: "refused", why: state.why };
      throw new Error("busy");
    }
    if (loadedBytes + need <= BUDGET) break;
    const all = [...slots];
    const younger = slots.has(slot) ? all.slice(all.indexOf(slot) + 1) : [];
    if (younger.length === 0 || waited >= WAIT_MAX) {
      slot.state = { kind: "refused", why: loadMessage() };
      throw new Error("busy");
    }
    const victim = younger.findLast((s) => s.state.kind === "running");
    if (victim) victim.state = { kind: "evicted", why: loadMessage() };
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  slots.add(slot);
  slot.held += need;
  loadedBytes += need;
}

// Runs a proxy handler. The handler reserves memory as its body streams in, and every reservation frees when it returns.
// A reservation past the budget aborts the handler, and the answer is 503.
export async function withSlot(
  factor: number,
  handler: (deps: { fetcher: typeof fetch; reservePixels: (pixels: number) => Promise<void> }) => Promise<Response>,
): Promise<Response> {
  const slot: Slot = { held: 0, state: { kind: "running" } };
  const fetcher: typeof fetch = async (input, init) => {
    if (slot.held === 0) await reserve(slot, CONNECTION);
    const res = await fetch(input, init);
    if (!res.body) return res;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, out) {
          await reserve(slot, chunk.length * factor);
          out.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, res);
  };
  const busy = (why: string) => {
    console.error(`busy: ${why}`);
    return new Response(`Busy: ${why}. Retry in a few seconds.`, { status: 503 });
  };
  try {
    const res = await handler({ fetcher, reservePixels: (pixels) => reserve(slot, pixels * BYTES_PER_PIXEL) });
    // An evicted request that finished before its next reserve keeps its answer and logs nothing.
    const state = slot.state;
    return state.kind === "refused" ? busy(state.why) : res;
  } catch (err) {
    // A handler that lets the refusal propagate (the thumb handler) ends here.
    const state = slot.state;
    if (state.kind === "refused") return busy(state.why);
    throw err;
  } finally {
    slot.state = { kind: "done" };
    slots.delete(slot);
    loadedBytes -= slot.held;
  }
}
