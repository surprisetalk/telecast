import type { Env } from "../../env";

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const url = new URL(request.url);
  const thumbUrl = decodeURIComponent(url.pathname.slice("/proxy/thumb/".length));
  const cached = await env.BUCKET_THUMB.get(thumbUrl);
  if (cached) {
    return new Response(cached.body, {
      headers: { "content-type": cached.httpMetadata?.contentType || "image/jpeg" },
    });
  }
  try {
    const fetchResponse = await fetch(thumbUrl);
    const contentType = fetchResponse.headers.get("content-type");
    if (!contentType?.startsWith("image/")) {
      return new Response("Invalid image", { status: 400 });
    }
    await env.BUCKET_THUMB.put(thumbUrl, fetchResponse.clone().body, {
      httpMetadata: { contentType },
    });
    return new Response(fetchResponse.body, {
      headers: { "content-type": contentType },
    });
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
}
