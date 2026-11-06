import db from "postgres";
import { encodeHex } from "jsr:@std/encoding@1/hex";
import { serveDir, serveFile } from "jsr:@std/http@1/file-server";
import { diskCache, sweep } from "./functions/_shared/cache.ts";
import { handleSearch } from "./functions/search.ts";
import { handleRssProxy } from "./functions/proxy/rss/[[path]].ts";
import { handleThumbProxy } from "./functions/proxy/thumb/[[path]].ts";
import { FEED_FACTOR, THUMB_FACTOR, withSlot } from "./functions/_shared/budget.ts";

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
// Status counts these lines: a visitor is the first 16 hex digits of sha256(UTC day + " " + CF-Connecting-IP).
// REVIEW: The set holds 16-hex strings for one day, empties at UTC midnight, and stops growing at 100000 with one log line per day.
// Alternative: crash at the bound. An attacker with a spoofed header could then take the site down.
// REVIEW: The hash is an unsalted sha256 of day and IP, so anyone who reads the journal can recover IPs by brute force over IPv4
// (2^32 hashes per day). Alternative: HMAC with a secret key. It costs a key to keep, and a key made per boot breaks the dedupe across restarts.
const MAX_VISITORS = 100_000;
let visitorDay = "";
let overflowLogged = false;
const visitors = new Set<string>();
async function logVisitor(req: Request): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== visitorDay) {
    visitorDay = day;
    visitors.clear();
    overflowLogged = false;
  }
  // Every request on pc comes through Cloudflare. Without the header there is no visitor to count.
  const ip = req.headers.get("CF-Connecting-IP");
  // scripts/status.ts probes /search each hour with this agent. It is not a person.
  if (!ip || req.headers.get("user-agent") === "telecast-status") return;
  const hash = encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day} ${ip}`))).slice(0, 16);
  if (visitors.has(hash)) return;
  if (visitors.size >= MAX_VISITORS) {
    if (overflowLogged) return;
    overflowLogged = true;
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
