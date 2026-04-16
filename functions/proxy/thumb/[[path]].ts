import type { Env } from "../../env";

const SMALL_WIDTH = 256;
const QUALITY = 80;

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
  deps: { bucket: R2Bucket; fetcher: typeof fetch },
  input: { thumbUrl: string },
): Promise<Response> {
  const { bucket, fetcher } = deps;
  const { thumbUrl } = input;
  if (!thumbUrl) return serveFallback();

  const smallKey = `small/${thumbUrl}`;
  const cached = await bucket.get(smallKey);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "content-type": cached.httpMetadata?.contentType || "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  const fetchUrl = transformYouTubeThumb(thumbUrl);
  let fetchResponse: Response;
  try {
    fetchResponse = await fetcher(fetchUrl, {
      cf: {
        image: {
          width: SMALL_WIDTH,
          fit: "scale-down",
          format: "webp",
          quality: QUALITY,
        },
      },
    } as RequestInit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`thumb proxy: fetch rejected for ${fetchUrl}: ${msg}`);
    return serveFallback();
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
  await bucket.put(smallKey, fetchResponse.clone().body, {
    httpMetadata: { contentType },
  });
  return new Response(fetchResponse.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  const thumbUrl = decodeURIComponent(url.pathname.slice("/proxy/thumb/".length));
  return handleThumbProxy({ bucket: env.BUCKET_THUMB, fetcher: fetch }, { thumbUrl });
}
