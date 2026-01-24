import type { Env } from "../../env";

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#2a2a2a"/>
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

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  const thumbUrl = decodeURIComponent(url.pathname.slice("/proxy/thumb/".length));
  if (!thumbUrl) return serveFallback();

  const cached = await env.BUCKET_THUMB.get(thumbUrl);
  if (cached) {
    return new Response(cached.body, {
      headers: { "content-type": cached.httpMetadata?.contentType || "image/jpeg" },
    });
  }
  try {
    const fetchResponse = await fetch(thumbUrl);
    if (!fetchResponse.ok) return serveFallback();

    const contentType = fetchResponse.headers.get("content-type");
    if (!contentType?.startsWith("image/")) return serveFallback();

    await env.BUCKET_THUMB.put(thumbUrl, fetchResponse.clone().body, {
      httpMetadata: { contentType },
    });
    return new Response(fetchResponse.body, {
      headers: { "content-type": contentType },
    });
  } catch {
    return serveFallback();
  }
}
