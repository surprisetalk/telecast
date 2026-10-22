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

// Deletes files written more than maxAgeMs ago, including temp files that a crash left. Returns the count.
export async function sweep(dir: string, maxAgeMs: number): Promise<number> {
  let n = 0;
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) throw new Error(`Expected only files in ${dir}, found ${p}. Remove it.`);
    let mtime: Date | null;
    try {
      mtime = (await Deno.stat(p)).mtime;
    } catch (err) {
      // A put renamed its temp file between readDir and stat.
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    if (!mtime) throw new Error(`Expected an mtime for ${p}, received null. The filesystem does not record modification times.`);
    if (Date.now() - mtime.getTime() > maxAgeMs) {
      await Deno.remove(p);
      n++;
    }
  }
  return n;
}
