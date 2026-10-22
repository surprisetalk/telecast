// Reads a response body up to maxBytes, so a large or endless body cannot exhaust memory. Returns null past the cap.
// Counts bytes as they arrive, because content-length can be absent or false.
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
