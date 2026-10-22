import sharp from "sharp";
import type { Cache } from "../../_shared/cache.ts";
import { readCapped } from "../../_shared/body.ts";

const SMALL_WIDTH = 256;
const QUALITY = 80;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_MB = 20;

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="#666" transform="translate(50,50)">
    <circle r="6"/>
    <path d="M0-14a14 14 0 0 1 0 28" fill="none" stroke="#666" stroke-width="2.5"/>
    <path d="M0-24a24 24 0 0 1 0 48" fill="none" stroke="#666" stroke-width="2.5"/>
  </g>
</svg>`;

function serveFallback(): Response {
  return new Response(FALLBACK_SVG, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" },
  });
}

export function transformYouTubeThumb(url: string): string {
  const ytMatch = url.match(/^(https?:\/\/i\d?\.ytimg\.com\/vi\/[^/]+\/)(?:hq|mq|)default\.jpg$/);
  if (ytMatch) return ytMatch[1] + "mqdefault.jpg";
  return url;
}

export async function handleThumbProxy(
  deps: { cache: Cache; fetcher: typeof fetch },
  input: { thumbUrl: string },
): Promise<Response> {
  const { cache, fetcher } = deps;
  const { thumbUrl } = input;
  if (!thumbUrl) return serveFallback();

  const smallKey = `small/${thumbUrl}`;
  const cached = await cache.get(smallKey);
  if (cached) {
    return new Response(cached.bytes, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  const fetchUrl = transformYouTubeThumb(thumbUrl);
  const fetchFailed = (err: unknown): Response => {
    const msg = err instanceof DOMException && err.name === "TimeoutError"
      ? `Timed out after ${FETCH_TIMEOUT_MS} ms fetching ${fetchUrl}`
      : err instanceof Error
      ? err.message
      : String(err);
    console.error(`thumb proxy: fetch rejected for ${fetchUrl}: ${msg}`);
    return serveFallback();
  };
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(fetchUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fetchFailed(err);
  }
  if (!fetchResponse.ok) {
    console.error(`thumb proxy: upstream ${fetchResponse.status} ${fetchResponse.statusText} for ${fetchUrl}`);
    return serveFallback();
  }
  const contentType = fetchResponse.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    console.error(`thumb proxy: non-image content-type ${contentType ?? "(none)"} for ${fetchUrl}`);
    return serveFallback();
  }
  let original: Uint8Array<ArrayBuffer> | null;
  try {
    original = await readCapped(fetchResponse, MAX_MB * 1e6);
  } catch (err) {
    return fetchFailed(err);
  }
  if (!original) {
    console.error(`thumb proxy: body from ${fetchUrl} is larger than ${MAX_MB} MB. Expected an image under ${MAX_MB} MB.`);
    return serveFallback();
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(
      await sharp(original).resize({ width: SMALL_WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer(),
    );
  } catch (err) {
    console.error(`thumb proxy: sharp could not resize ${contentType} from ${fetchUrl}: ${err instanceof Error ? err.message : err}`);
    return serveFallback();
  }
  await cache.put(smallKey, body);
  return new Response(body, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
