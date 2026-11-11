import db from "postgres";
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
// deno serve exits on SIGTERM when the event loop drains. postgres.js keeps an idle connection open for its max_lifetime, 30 to 60
// min, so systemd waited its 90 s and killed the unit on each deploy. end() lets running queries finish for up to 5 s.
Deno.addSignalListener("SIGTERM", () => sql.end({ timeout: 5 }));
const rssCache = await diskCache("cache/rss");
const thumbCache = await diskCache("cache/thumb");
// Visitors choose the cached URLs, so old files go, and status watches the total size and free disk.
const CACHE_MAX_AGE_MS = 7 * 86_400_000;
const sweepCaches = () => Promise.all(["cache/rss", "cache/thumb"].map((d) => sweep(d, CACHE_MAX_AGE_MS)));
await sweepCaches();
// A rejected sweep is unhandled, so the server crashes and systemd restarts it. unrefTimer lets SIGTERM's graceful shutdown
// finish: deno serve waits for the event loop to drain, and a ref'd interval never drains.
Deno.unrefTimer(setInterval(sweepCaches, 3_600_000));
let feedsOpen = false;
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
    if (pathname === "/search") return handleSearch({ sql }, { query: searchParams.get("q") });
    // REVIEW: /feeds.json is public, like /search. Alternative: a bearer token that shelob sends. It hides the list of feed URLs
    // from scrapers but costs a secret on both hosts and a 401 path. The list is no more private than /search, which returns
    // channels with their rss URLs.
    // REVIEW: No ETag or Last-Modified. A correct validator needs a hash over every row, which is the full scan, and max(updated_at)
    // misses deleted channels. Shelob checksums the body, so a changed list is the only cost. Alternative: a version counter
    // kept by a trigger.
    if (pathname === "/feeds.json") {
      // REVIEW: One reader at a time, a second answers 503 Busy. The cursor holds one of postgres.js's 10 connections and a sort of every
      // channel for as long as the client reads, so 10 stalled public clients would block /search. Alternative: a per-IP limit. It
      // needs a table of IPs and trusts a proxy header. Cost: shelob and a curl check cannot read at once.
      if (feedsOpen) return new Response("Busy. Expected one /feeds.json reader at a time. Retry in a minute.", { status: 503 });
      feedsOpen = true;
      // "C" collation sorts by bytes, so the same set gives the same bytes on any locale. distinct drops a URL that two channels share.
      // The cursor reads 5,000 rows per round trip, and the stream pulls only as fast as the client reads.
      const batches = sql`select distinct rss collate "C" as rss from channel order by rss`.values().cursor(5000)[Symbol.asyncIterator]();
      let head: IteratorResult<string[][]>;
      // The first batch is read before the response starts, so a database failure answers 500 and not a cut-off 200.
      try {
        head = await batches.next();
      } catch (e) {
        feedsOpen = false;
        console.error(`feeds.json failed: ${e}`);
        return new Response("Feeds failed. Expected the channel table to answer. Check that postgres is up.", { status: 500 });
      }
      const enc = new TextEncoder();
      // The finally opens the guard on every way out: the last batch, a failed read, and a cancel, which calls the generator's return().
      return new Response(
        ReadableStream.from((async function* () {
          try {
            let sep = "[";
            for (let batch = head; !batch.done; batch = await batches.next()) {
              let text = "";
              for (const [rss] of batch.value) {
                text += sep + JSON.stringify(rss);
                sep = ",";
              }
              yield enc.encode(text);
            }
            yield enc.encode(sep === "[" ? "[]" : "]");
          } finally {
            feedsOpen = false;
            await batches.return?.();
          }
        })()),
        { headers: { "content-type": "application/json" } },
      );
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
