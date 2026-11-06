import sharp from "sharp";
import type { Cache } from "../../_shared/cache.ts";
import { readCapped } from "../../_shared/body.ts";

const SMALL_WIDTH = 256;
const QUALITY = 80;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_MB = 20;
// A small compressed image can decode to gigabytes. 25 MP is 5000x5000, above any podcast artwork.
const MAX_PIXELS = 25e6;

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
  deps: { cache: Cache; fetcher: typeof fetch; reservePixels: (pixels: number) => Promise<void> },
  input: { thumbUrl: string },
): Promise<Response> {
  const { cache, fetcher, reservePixels } = deps;
  const { thumbUrl } = input;
  if (!thumbUrl) return serveFallback();
  // Deno's fetch reads file: and data: URLs, so anything but http and https could leak local files.
  if (!/^https?:$/.test(URL.parse(thumbUrl)?.protocol ?? "")) {
    return new Response(`Expected an http or https URL, received ${thumbUrl}. Encode the URL with encodeURIComponent.`, { status: 400 });
  }

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
    console.error(`thumb proxy: fetch rejected for ${JSON.stringify(fetchUrl)}: ${JSON.stringify(msg)}`);
    return serveFallback();
  };
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(fetchUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fetchFailed(err);
  }
  if (!fetchResponse.ok) {
    console.error(`thumb proxy: upstream ${fetchResponse.status} ${fetchResponse.statusText} for ${JSON.stringify(fetchUrl)}`);
    return serveFallback();
  }
  const contentType = fetchResponse.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    console.error(`thumb proxy: non-image content-type ${JSON.stringify(contentType)} for ${JSON.stringify(fetchUrl)}`);
    return serveFallback();
  }
  const sharpFailed = (err: unknown): Response => {
    console.error(
      `thumb proxy: sharp could not resize ${contentType} from ${JSON.stringify(fetchUrl)}: ${
        JSON.stringify(err instanceof Error ? err.message : String(err))
      }`,
    );
    return serveFallback();
  };
  let original: Uint8Array<ArrayBuffer> | null;
  try {
    original = await readCapped(fetchResponse, MAX_MB * 1e6);
  } catch (err) {
    return fetchFailed(err);
  }
  if (!original) {
    console.error(`thumb proxy: body from ${JSON.stringify(fetchUrl)} is larger than ${MAX_MB} MB. Expected an image under ${MAX_MB} MB.`);
    return serveFallback();
  }
  // The header gives the pixel count before sharp decodes. A decode holds about as many bytes as the pixels, whatever the file size.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(original).metadata();
  } catch (err) {
    return sharpFailed(err);
  }
  const { width, height } = meta;
  if (!width || !height) {
    throw new Error(
      `Expected sharp to report a width and height for ${contentType} from ${JSON.stringify(fetchUrl)}, received ${width} x ${height}.`,
    );
  }
  // A Busy refusal propagates to withSlot, which answers 503 and logs one busy: line.
  await reservePixels(Math.min(width * height, MAX_PIXELS));
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(
      await sharp(original, { limitInputPixels: MAX_PIXELS }).resize({ width: SMALL_WIDTH, withoutEnlargement: true }).webp({
        quality: QUALITY,
      }).toBuffer(),
    );
  } catch (err) {
    return sharpFailed(err);
  }
  await cache.put(smallKey, body);
  return new Response(body, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
