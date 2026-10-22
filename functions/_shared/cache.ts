import { encodeHex } from "jsr:@std/encoding@1/hex";

export type Cache = {
  get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; at: Date } | null>;
  put(key: string, body: Uint8Array | string): Promise<void>;
};

export async function diskCache(dir: string): Promise<Cache> {
  const probe = `${dir}/.probe-${crypto.randomUUID()}`;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(probe, "");
    await Deno.remove(probe);
  } catch (e) {
    throw new Error(`Cannot write ${dir}/ in ${Deno.cwd()}: ${e instanceof Error ? e.message : e}. Expected a writable directory.`);
  }
  // Keys are URLs, so the file name is their sha256.
  const path = async (key: string) => `${dir}/${encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))}`;
  return {
    async get(key) {
      const p = await path(key);
      try {
        const [bytes, info] = await Promise.all([Deno.readFile(p), Deno.stat(p)]);
        if (!info.mtime) throw new Error(`Expected an mtime for ${p}, received null. The filesystem does not record modification times.`);
        return { bytes, at: info.mtime };
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return null;
        throw e;
      }
    },
    async put(key, body) {
      const p = await path(key);
      // Write then rename, so a crash never leaves a partial file under the final name.
      const tmp = `${p}.tmp-${crypto.randomUUID()}`;
      await Deno.writeFile(tmp, typeof body === "string" ? new TextEncoder().encode(body) : body);
      await Deno.rename(tmp, p);
    },
  };
}
