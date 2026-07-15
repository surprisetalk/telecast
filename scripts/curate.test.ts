import { assertEquals } from "jsr:@std/assert";
import { selectFeatured } from "./curate.ts";

const base = { perTagLimit: 2, minQuality: 30, featuredPin: [] as string[], blocked: [] as string[] };

const rows = [
  { channel_id: "a", tags: ["technology"], quality: 90 },
  { channel_id: "b", tags: ["technology"], quality: 80 },
  { channel_id: "c", tags: ["technology"], quality: 70 },
  { channel_id: "d", tags: ["music", "synthesizers"], quality: 85 },
  { channel_id: "e", tags: ["music"], quality: 20 }, // below minQuality
  { channel_id: "f", tags: null, quality: 99 }, // no tags
];

Deno.test("selectFeatured: top-N per tag by quality desc", () => {
  // technology top-2 = a,b (c excluded); synthesizers+music top = d; e below threshold; f untagged
  assertEquals(selectFeatured(rows, base), ["a", "b", "d"]);
});

Deno.test("selectFeatured: minQuality filters low-quality channels", () => {
  // at minQuality 88 only a(90) qualifies; d(85) drops out
  assertEquals(selectFeatured(rows, { ...base, minQuality: 88 }), ["a"]);
});

Deno.test("selectFeatured: pin adds regardless of tag/quality, blocked wins over everything", () => {
  assertEquals(selectFeatured(rows, { ...base, featuredPin: ["e", "f"] }), ["a", "b", "d", "e", "f"]);
  // blocking a (the #1 technology channel) frees its slot for c; pinned f is also blocked → dropped
  assertEquals(selectFeatured(rows, { ...base, featuredPin: ["f"], blocked: ["a", "f"] }), ["b", "c", "d"]);
});

Deno.test("selectFeatured: empty input → empty output", () => {
  assertEquals(selectFeatured([], base), []);
  assertEquals(selectFeatured(rows, { ...base, perTagLimit: 0, minQuality: 200 }), []);
});

Deno.test("selectFeatured: dedups a channel matching multiple topic tags", () => {
  const multi = [{ channel_id: "x", tags: ["music", "synthesizers", "music-production"], quality: 95 }];
  assertEquals(selectFeatured(multi, base), ["x"]);
});
