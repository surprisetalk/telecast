import { assertEquals } from "jsr:@std/assert";
import { grade, Measurements } from "./status.ts";

const healthy: Measurements = {
  search: { ok: 400 },
  db: { ok: { freshS: 300, refreshed: 1000, failed: 100, bytes: 5e9 } },
  curate: { ok: 3600 },
  seed: { ok: 3 * 86_400 },
};
const scores = (m: Measurements) => grade(m).map((c) => Math.round(c.score * 100) / 100);

Deno.test("grade: healthy production passes every condition", () => {
  assertEquals(scores(healthy), [5, 3, 1.13, 48, 2.67, 10]);
});

Deno.test("grade: each failure mode scores below 1.0", () => {
  assertEquals(
    scores({
      search: { ok: 4000 },
      db: { ok: { freshS: 8_488_777, refreshed: 10, failed: 5, bytes: 100e9 } },
      curate: { ok: null },
      seed: { ok: 16 * 86_400 },
    }),
    [0.5, 0, 0.63, 0, 0.5, 0.5],
  );
});

Deno.test("grade: errors and empty data score 0", () => {
  assertEquals(
    scores({ search: { error: "HTTP 500" }, db: { error: "connect ECONNREFUSED" }, curate: { error: "HTTP 403" }, seed: { ok: null } }),
    [0, 0, 0, 0, 0, 0],
  );
  assertEquals(scores({ ...healthy, db: { ok: { freshS: null, refreshed: 0, failed: 0, bytes: 5e9 } } }), [5, 0, 0, 48, 2.67, 10]);
});
