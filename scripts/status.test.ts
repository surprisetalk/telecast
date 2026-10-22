import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { dbStats, fenceHolds, grade, Measurements } from "./status.ts";

const healthy: Measurements = {
  search: { ok: 400 },
  db: { ok: { freshS: 300, refreshed: 1000, failed: 100, bytes: 5e9 } },
  curate: { ok: 3600 },
  seed: { ok: 3 * 86_400 },
  fence: { ok: true },
};
const scores = (m: Measurements) => grade(m).map((c) => Math.round(c.score * 100) / 100);

Deno.test("grade: healthy production passes every condition", () => {
  assertEquals(scores(healthy), [5, 3, 1.13, 48, 2.67, 10, 1]);
});

Deno.test("grade: each failure mode scores below 1.0", () => {
  assertEquals(
    scores({
      search: { ok: 4000 },
      db: { ok: { freshS: 8_488_777, refreshed: 10, failed: 5, bytes: 100e9 } },
      curate: { ok: null },
      seed: { ok: 16 * 86_400 },
      fence: { ok: false },
    }),
    [0.5, 0, 0.63, 0, 0.5, 0.5, 0],
  );
});

Deno.test("grade: errors and empty data score 0", () => {
  assertEquals(
    scores({
      search: { error: "HTTP 500" },
      db: { error: "connect ECONNREFUSED" },
      curate: { error: "HTTP 403" },
      seed: { ok: null },
      fence: { error: "HTTP 500" },
    }),
    [0, 0, 0, 0, 0, 0, 0],
  );
  assertEquals(scores({ ...healthy, db: { ok: { freshS: null, refreshed: 0, failed: 0, bytes: 5e9 } } }), [5, 0, 0, 48, 2.67, 10, 1]);
});

Deno.test("grade: a non-finite score throws instead of printing invalid JSON", () => {
  assertThrows(() => grade({ ...healthy, db: { ok: { freshS: 300, refreshed: 1000, failed: 100, bytes: 0 } } }), Error, "Infinity");
  assertThrows(() => grade({ ...healthy, search: { ok: NaN } }), Error, "NaN");
});

Deno.test("dbStats: a malformed DATABASE_URL error never shows the password", async () => {
  const err = await assertRejects(() => dbStats("postgres://user:S3CRETPW@@host:notaport/db"));
  assert(!(err as Error).message.includes("S3CRETPW"), (err as Error).message);
});

Deno.test("dbStats: a password with a bare % names the fix and hides the password", async () => {
  const err = await assertRejects(() => dbStats("postgres://u:p%zzw@127.0.0.1:2/db"), Error, "written as %25");
  assert(!(err as Error).message.includes("p%zzw"), (err as Error).message);
});

Deno.test("fenceHolds: only a timeout from the feed proxy means pc's loopback is unreachable", () => {
  assertEquals(fenceHolds(502, "Network error fetching http://127.0.0.1:2/ (raw input: x): Timed out after 15000 ms fetching x"), true);
  assertEquals(fenceHolds(502, "Network error fetching http://127.0.0.1:2/ (raw input: x): Connection refused (os error 111)"), false);
  assertEquals(fenceHolds(400, "Not a valid feed at http://127.0.0.1:2/"), false);
  assertEquals(fenceHolds(502, "Upstream feed fetch failed for http://127.0.0.1:2/: HTTP 404"), false);
  assertThrows(() => fenceHolds(500, "Internal Server Error"), Error, "Expected 502 or 400");
});
