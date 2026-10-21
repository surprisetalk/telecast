import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseCuration, selectFeatured } from "./curate.ts";

Deno.test("empty priority → empty", () => {
  assertEquals(selectFeatured({ priority: [], blocked: [] }), []);
});

Deno.test("priority is always featured, sorted", () => {
  assertEquals(selectFeatured({ priority: ["f", "e"], blocked: [] }), ["e", "f"]);
});

Deno.test("blocked beats priority", () => {
  assertEquals(selectFeatured({ priority: ["e", "f"], blocked: ["e"] }), ["f"]);
});

Deno.test("parseCuration: non-object JSON names the file, expected shape, and received value", () => {
  for (const text of ["null", "[]", "3"]) {
    assertThrows(() => parseCuration(text), Error, `curation.json: expected an object {"priority": [...], "blocked": [...]}, got ${text}`);
  }
});
