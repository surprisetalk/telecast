export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const thumbUrl = decodeURIComponent(
    url.pathname.slice("/proxy/thumb/".length),
  );
  let response = await env.BUCKET_THUMB.get(thumbUrl);
  if (!response) {
    try {
      response = await fetch(thumbUrl);
      const contentType = response.headers.get("content-type");
      if (!contentType?.startsWith("image/")) {
        return new Response("Invalid image", { status: 400 });
      }
      await env.BUCKET_THUMB.put(thumbUrl, response.clone());
    } catch (error) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }
  return new Response(response.body, {
    headers: response.headers,
  });
}
