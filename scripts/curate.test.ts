import { assertEquals } from "jsr:@std/assert";
import { selectFeatured } from "./curate.ts";

Deno.test("empty priority → empty", () => {
  assertEquals(selectFeatured({ priority: [], blocked: [] }), []);
});

Deno.test("priority is always featured, sorted", () => {
  assertEquals(selectFeatured({ priority: ["f", "e"], blocked: [] }), ["e", "f"]);
});

Deno.test("blocked beats priority", () => {
  assertEquals(selectFeatured({ priority: ["e", "f"], blocked: ["e"] }), ["f"]);
});
