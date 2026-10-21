import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseCuration, selectFeatured } from "./curate.ts";

Deno.test("empty priority → empty", () => {
  assertEquals(selectFeatured({ priority: [], blocked: [] }, new Set()), []);
});

Deno.test("priority is always featured, sorted", () => {
  assertEquals(selectFeatured({ priority: ["f", "e"], blocked: [] }, new Set(["e", "f"])), ["e", "f"]);
});

Deno.test("blocked beats priority", () => {
  assertEquals(selectFeatured({ priority: ["e", "f"], blocked: ["e"] }, new Set(["f"])), ["f"]);
});

Deno.test("parseCuration: non-object JSON names the file, expected shape, and received value", () => {
  for (const text of ["null", "[]", "3"]) {
    assertThrows(() => parseCuration(text), Error, `curation.json: expected an object {"priority": [...], "blocked": [...]}, got ${text}`);
  }
});

Deno.test("selectFeatured: priority id with no channel row throws naming the id", () => {
  assertThrows(
    () => selectFeatured({ priority: ["UCdead", "UClive"], blocked: [] }, new Set(["UClive"])),
    Error,
    "curation.json: priority id UCdead matches no channel row",
  );
});
