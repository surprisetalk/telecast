import db from "postgres";
import { serveDir, serveFile } from "jsr:@std/http@1/file-server";
import { diskCache } from "./functions/_shared/cache.ts";
import { handleSearch } from "./functions/search.ts";
import { handleRssProxy } from "./functions/proxy/rss/[[path]].ts";
import { handleThumbProxy } from "./functions/proxy/thumb/[[path]].ts";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  throw new Error(
    "DATABASE_URL is missing. Expected postgres://telecast:<password>@%2Frun%2Fpostgresql/telecast in .env. Received undefined.",
  );
}
const sql = db(url);
const rssCache = await diskCache("cache/rss");
const thumbCache = await diskCache("cache/thumb");
const PUBLIC = `${import.meta.dirname}/public`;

export default {
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    const badPath = () =>
      new Response(`Expected a percent-encoded path with no %00, received ${pathname}. Encode the URL with encodeURIComponent.`, {
        status: 400,
      });
    let path: string;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      return badPath();
    }
    // Deno's file APIs throw on a NUL byte.
    if (path.includes("\0")) return badPath();
    if (pathname === "/search") return handleSearch({ sql }, { query: searchParams.get("q") });
    if (pathname.startsWith("/proxy/rss/")) {
      return handleRssProxy({ sql, cache: rssCache, fetcher: fetch }, { rssUrl: path.slice("/proxy/rss/".length) });
    }
    if (pathname.startsWith("/proxy/thumb/")) {
      return handleThumbProxy({ cache: thumbCache, fetcher: fetch }, {
        thumbUrl: path.slice("/proxy/thumb/".length),
      });
    }
    const res = await serveDir(req, { fsRoot: PUBLIC, quiet: true });
    // Elm pushes paths like /episode/..., so a missing path without a file extension is an app route.
    if (res.status === 404 && !pathname.split("/").pop()!.includes(".")) return serveFile(req, `${PUBLIC}/index.html`);
    return res;
  },
} satisfies Deno.ServeDefaultExport;
