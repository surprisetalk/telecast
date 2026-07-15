import { assertEquals } from "jsr:@std/assert";
import { selectFeatured } from "./curate.ts";

const base = {
  autoPromote: false,
  perTagLimit: 2,
  minQuality: 30,
  priority: [] as string[],
  blocked: [] as string[],
};

const rows = [
  { channel_id: "a", tags: ["technology"], quality: 90 },
  { channel_id: "b", tags: ["technology"], quality: 80 },
  { channel_id: "c", tags: ["technology"], quality: 70 },
  { channel_id: "d", tags: ["music", "synthesizers"], quality: 85 },
  { channel_id: "e", tags: ["music"], quality: 20 }, // below minQuality
  { channel_id: "f", tags: null, quality: 99 }, // no tags
];

Deno.test("autoPromote off + no priority → empty", () => {
  assertEquals(selectFeatured(rows, base), []);
});

Deno.test("priority is always featured regardless of tag/quality", () => {
  // e (below floor) and f (untagged) are featured purely because they're priority
  assertEquals(selectFeatured(rows, { ...base, priority: ["e", "f"] }), ["e", "f"]);
});

Deno.test("blocked beats priority", () => {
  assertEquals(selectFeatured(rows, { ...base, priority: ["e", "f"], blocked: ["e"] }), ["f"]);
});

Deno.test("autoPromote on: top-N per tag by quality", () => {
  // technology top-2 = a,b (c excluded); synthesizers+music top = d; e below floor; f untagged
  assertEquals(selectFeatured(rows, { ...base, autoPromote: true }), ["a", "b", "d"]);
});

Deno.test("autoPromote on: minQuality filters low-quality channels", () => {
  assertEquals(selectFeatured(rows, { ...base, autoPromote: true, minQuality: 88 }), ["a"]);
});

Deno.test("autoPromote on: priority is added on top of the algorithmic fill", () => {
  // e is below the floor but featured because it's priority; a,b,d come from the scan
  assertEquals(selectFeatured(rows, { ...base, autoPromote: true, priority: ["e"] }), ["a", "b", "d", "e"]);
});

Deno.test("autoPromote on: blocking the #1 channel frees its slot for the next", () => {
  assertEquals(selectFeatured(rows, { ...base, autoPromote: true, blocked: ["a"] }), ["b", "c", "d"]);
});

Deno.test("autoPromote on: dedups a channel matching multiple topic tags", () => {
  const multi = [{ channel_id: "x", tags: ["music", "synthesizers", "music-production"], quality: 95 }];
  assertEquals(selectFeatured(multi, { ...base, autoPromote: true }), ["x"]);
});
