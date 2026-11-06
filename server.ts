import db from "postgres";
import { encodeHex } from "jsr:@std/encoding@1/hex";
import { serveDir, serveFile } from "jsr:@std/http@1/file-server";
import { diskCache, sweep } from "./functions/_shared/cache.ts";
import { handleSearch } from "./functions/search.ts";
import { handleRssProxy } from "./functions/proxy/rss/[[path]].ts";
import { handleThumbProxy } from "./functions/proxy/thumb/[[path]].ts";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  throw new Error(
    "DATABASE_URL is missing. Expected a postgres:// URL in .env, or postgres:///telecast with PGHOST, PGUSER, and PGPASSWORD for a socket. Received undefined.",
  );
}
const sql = db(url);
const rssCache = await diskCache("cache/rss");
const thumbCache = await diskCache("cache/thumb");
// Visitors choose the cached URLs, so old files go, and status watches the total size and free disk.
const CACHE_MAX_AGE_MS = 7 * 86_400_000;
const sweepCaches = () => Promise.all(["cache/rss", "cache/thumb"].map((d) => sweep(d, CACHE_MAX_AGE_MS)));
await sweepCaches();
// A rejected sweep is unhandled, so the server crashes and systemd restarts it. unrefTimer lets SIGTERM's graceful shutdown
// finish: deno serve waits for the event loop to drain, and a ref'd interval never drains.
Deno.unrefTimer(setInterval(sweepCaches, 3_600_000));
// Memory budget. telecast-web has MemoryMax=2G, and systemd kills it above that: the site is down for the 30 s RestartSec.
// Measured with `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 deno serve ...` on a scratch Postgres, 45 MB
// RSS items (/proxy/rss/ ?n=i, distinct upstream URLs) and a 25 MP, 11 MB PNG (/proxy/thumb/). VmHWM of the deno process, idle 0.10 GB:
//   rss, parallel 1 / 4 / 8 / 16 / 30 / 60: 0.52 / 1.04 / 1.50 / 1.60 / 2.65 / 3.1 GB. Past 8, the 15 s fetch timeout answers 502 for most.
//   thumb, parallel 1 / 4 / 8: 0.14 / 0.28 / 0.43 GB.
// 60 parallel feeds peak above 2 GB, so a cap is needed. Peak per request: 0.94 GB / 4 feeds, rounded up to 280 MB per 45 MB feed.
// 0.34 GB / 8 thumbs, rounded up to 50 MB per 25 MP, 11 MB image. With the budget below, VmHWM peaked at: 60 parallel 45 MB feeds
// 1.67 GB; 80 parallel 25 MP PNGs of 14.5 MB 1.74 GB; 60 feeds with 60 thumbs 1.13 GB. The kill line is 2.15 GB.
// Reproduce: run the serve task under the systemd-run scope above, serve the feed and the PNG from a local Deno.serve, fire N parallel
// requests, and read VmHWM in /proc/<pid>/status.
// REVIEW: One budget covers both proxies, and a request reserves what it holds as it holds it: bytes read times a measured factor,
// and for a thumb the decoded pixels. Alternative: weigh each request at its worst case up front. It is simpler, but 40 small thumbs
// then answer 503 Busy though they hold 4 MB. Cost: a reservation can fail mid-body, so the work so far is lost.
// REVIEW: Only requests that call fetch take a slot, so cache hits never get a 503. Alternative: wrap the whole handler. It also
// counts cache hits, and a library load of 30 cached feeds would 503. Cost: a cache hit on a 45 MB feed is not counted.
const MB = 1e6;
// 10% headroom: 80 parallel thumbs peaked at 2.04 GB with the full 1948 MB, 2.5% under the kill line.
const BUDGET = 0.9 * (2048 - 100) * MB;
// A request that has called fetch holds a socket and parser state.
const CONNECTION = 1 * MB;
// A feed of 45 MB peaked at 280 MB: the chunks, the joined copy, the decoded string, and the parse.
const FEED_FACTOR = 280 / 45;
// A 25 MP, 11 MB PNG peaked at 50 MB. The chunks and the joined copy are 2 x 11 MB. The pixels are the rest.
const THUMB_FACTOR = 2;
const BYTES_PER_PIXEL = (50 - THUMB_FACTOR * 11) * MB / 25e6;
// A request that cannot reserve evicts the youngest request younger than itself and retries, so the oldest requests finish.
// Without it, 60 feeds that start together all stall at the budget and all answer 503.
const WAIT_MS = 10;
const WAIT_MAX = 100;
// busy is set on eviction. refused is set when a reserve threw, so the handler did not finish.
type Slot = { held: number; busy?: string; refused: boolean };
// Insertion order is arrival order.
const slots = new Set<Slot>();
let loadedBytes = 0;

function flagBusy(slot: Slot): void {
  slot.busy ??= `${slots.size} feeds and thumbs are loading and use ${Math.round(loadedBytes / MB)} of ${Math.round(BUDGET / MB)} MB`;
}

async function reserve(slot: Slot, bytes: number): Promise<void> {
  const need = Math.ceil(bytes);
  for (let waited = 0;; waited++) {
    // The YouTube resolver swallows the first rejection and fetches again. A Busy request stays Busy and logs once.
    if (slot.busy) {
      slot.refused = true;
      throw new Error("busy");
    }
    if (loadedBytes + need <= BUDGET) break;
    const all = [...slots];
    const younger = slots.has(slot) ? all.slice(all.indexOf(slot) + 1) : [];
    if (younger.length === 0 || waited >= WAIT_MAX) {
      flagBusy(slot);
      slot.refused = true;
      throw new Error("busy");
    }
    const victim = younger.findLast((s) => !s.busy);
    if (victim) flagBusy(victim);
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  slots.add(slot);
  slot.held += need;
  loadedBytes += need;
}

// Runs a proxy handler. The handler reserves memory as its body streams in, and every reservation frees when it returns.
// A reservation past the budget aborts the handler, and the answer is 503.
async function withSlot(
  factor: number,
  handler: (deps: { fetcher: typeof fetch; reservePixels: (pixels: number) => Promise<void> }) => Promise<Response>,
): Promise<Response> {
  const slot: Slot = { held: 0, refused: false };
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
  try {
    const res = await handler({ fetcher, reservePixels: (pixels) => reserve(slot, pixels * BYTES_PER_PIXEL) });
    // An evicted request that finished before its next reserve keeps its answer and logs nothing.
    if (!slot.refused) return res;
    console.error(`busy: ${slot.busy!}`);
    return new Response(`Busy: ${slot.busy!}. Retry in a few seconds.`, { status: 503 });
  } finally {
    slots.delete(slot);
    loadedBytes -= slot.held;
  }
}

// Status counts these lines: a visitor is the first 16 hex digits of sha256(UTC day + " " + CF-Connecting-IP).
// REVIEW: The set holds 16-hex strings for one day, empties at UTC midnight, and stops growing at 100000 with one log line.
// Alternative: crash at the bound. An attacker with a spoofed header could then take the site down.
const MAX_VISITORS = 100_000;
let visitorDay = "";
const visitors = new Set<string>();
async function logVisitor(req: Request): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== visitorDay) {
    visitorDay = day;
    visitors.clear();
  }
  // Every request on pc comes through Cloudflare. Without the header there is no visitor to count.
  const ip = req.headers.get("CF-Connecting-IP");
  // scripts/status.ts probes /search each hour with this agent. It is not a person.
  if (!ip || req.headers.get("user-agent") === "telecast-status") return;
  const hash = encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day} ${ip}`))).slice(0, 16);
  if (visitors.has(hash)) return;
  if (visitors.size >= MAX_VISITORS) {
    console.error(`visitors: more than ${MAX_VISITORS} on ${day}. Later visitors are not counted today.`);
    return;
  }
  visitors.add(hash);
  console.error(`visitor ${hash}`);
}
const PUBLIC = `${import.meta.dirname}/public`;

export default {
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    let path: string;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      return new Response(`Expected a valid percent-encoded path, received ${pathname}. Encode the URL with encodeURIComponent.`, {
        status: 400,
      });
    }
    // Deno's file APIs throw on a NUL byte.
    if (path.includes("\0")) return new Response(`Expected a path with no %00, received ${pathname}.`, { status: 400 });
    if (pathname === "/search") {
      await logVisitor(req);
      return handleSearch({ sql }, { query: searchParams.get("q") });
    }
    if (pathname.startsWith("/proxy/rss/")) {
      return withSlot(
        FEED_FACTOR,
        ({ fetcher }) => handleRssProxy({ sql, cache: rssCache, fetcher }, { rssUrl: path.slice("/proxy/rss/".length) }),
      );
    }
    if (pathname.startsWith("/proxy/thumb/")) {
      return withSlot(THUMB_FACTOR, ({ fetcher, reservePixels }) =>
        handleThumbProxy({ cache: thumbCache, fetcher, reservePixels }, {
          thumbUrl: path.slice("/proxy/thumb/".length),
        }));
    }
    // No file name in public/ passes 255 bytes, and a longer one makes Deno's stat throw, which serveDir turns into a 500.
    if (path.split("/").some((seg) => new TextEncoder().encode(seg).length > 255)) return new Response("Not Found", { status: 404 });
    const res = await serveDir(req, { fsRoot: PUBLIC, quiet: true });
    // Elm pushes paths like /episode/..., so a missing path without a file extension is an app route.
    if (res.status === 404 && !pathname.split("/").pop()!.includes(".")) return serveFile(req, `${PUBLIC}/index.html`);
    return res;
  },
} satisfies Deno.ServeDefaultExport;
