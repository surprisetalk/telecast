import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import {
  atJournalCap,
  backupAgeS,
  cacheBytes,
  countBusy,
  countVisitors,
  dbStats,
  fenceHolds,
  grade,
  lastFinishAgeS,
  Measurements,
  parseDf,
  parseLsRemote,
  parseMemory,
  parseStartS,
  servedCommit,
} from "./status.ts";

const healthy: Measurements = {
  search: { ok: 400 },
  db: { ok: { freshS: 300, refreshed: 1000, failed: 100, bytes: 5e9 } },
  curate: { ok: 3600 },
  seed: { ok: 3 * 86_400 },
  fence: { ok: true },
  cache: { ok: 1e9 },
  disk: { ok: { availBytes: 400e9, sizeBytes: 1e12 } },
  refresh: { ok: 300 },
  deploy: { ok: { head: "a".repeat(40), origin: "a".repeat(40), startS: 200, reflogS: 100 } },
  busy: { ok: 2 },
  visitors: { ok: 20 },
  backup: { ok: 3600 },
  memory: { ok: { peakBytes: 0.9e9, maxBytes: 2e9 } },
};
const scores = (m: Measurements) => grade(m).map((c) => Math.round(c.score * 100) / 100);

Deno.test("grade: healthy production passes every condition", () => {
  assertEquals(scores(healthy), [5, 3, 1.13, 48, 2.67, 10, 1, 3, 1, 5, 2, 26, 2, 5, 4]);
});

Deno.test("grade: each failure mode scores below 1.0", () => {
  assertEquals(
    scores({
      search: { ok: 4000 },
      db: { ok: { freshS: 8_488_777, refreshed: 10, failed: 5, bytes: 100e9 } },
      curate: { ok: null },
      seed: { ok: 16 * 86_400 },
      fence: { ok: false },
      cache: { ok: 10e9 },
      disk: { ok: { availBytes: 50e9, sizeBytes: 1e12 } },
      refresh: { ok: 1800 },
      deploy: { ok: { head: "a".repeat(40), origin: "b".repeat(40), startS: 200, reflogS: 100 } },
      busy: { ok: 20 },
      visitors: { ok: 0 },
      backup: { ok: 52 * 3600 },
      memory: { ok: { peakBytes: 1.9e9, maxBytes: 2e9 } },
    }),
    [0.5, 0, 0.63, 0, 0.5, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.95, 0.5, 0.5],
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
      cache: { error: "EACCES" },
      disk: { error: "df exited 1" },
      refresh: { ok: null },
      deploy: { error: "git failed" },
      busy: { error: "journalctl failed" },
      visitors: { error: "journalctl failed" },
      backup: { ok: null },
      memory: { error: "systemctl failed" },
    }),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assertEquals(scores({ ...healthy, db: { ok: { freshS: null, refreshed: 0, failed: 0, bytes: 5e9 } } }), [
    5,
    0,
    0,
    48,
    2.67,
    10,
    1,
    3,
    1,
    5,
    2,
    26,
    2,
    5,
    4,
  ]);
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
  assertThrows(() => fenceHolds(502, "error code: 502"), Error, "Check that telecast-web on pc serves the site.");
});

Deno.test("parseDf: reads size and free space even when the file system name has a space", () => {
  const header = "Filesystem 1024-blocks Used Available Capacity Mounted on\n";
  assertEquals(parseDf(header + "/dev/nvme0n1p2 1000 600 400 60% /\n"), { sizeBytes: 1024000, availBytes: 409600 });
  assertEquals(parseDf(header + "map auto_home 1000 600 400 60% /System/Volumes/Data/home\n"), { sizeBytes: 1024000, availBytes: 409600 });
  assertThrows(() => parseDf("df: cache: No such file or directory\n"), Error, "Expected df -Pk cache");
});

Deno.test("cacheBytes: sums files and skips an entry that vanished or dangles", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/a`, "12345");
  await Deno.symlink(`${dir}/gone`, `${dir}/dangling`);
  assertEquals(await cacheBytes([dir]), 5);
});

Deno.test("lastFinishAgeS: reads the age of a unit's last finished job from journalctl JSON", () => {
  const now = 1_792_675_600_000;
  const line = JSON.stringify({ UNIT: "telecast-curate.service", __REALTIME_TIMESTAMP: "1792675500548570" });
  assertEquals(Math.round(lastFinishAgeS("telecast-curate.service", line + "\n", now)!), 99);
  assertEquals(lastFinishAgeS("telecast-curate.service", "", now), null);
  assertThrows(() => lastFinishAgeS("telecast-curate.service", "-- No entries --", now), Error, "Expected journalctl JSON");
  assertThrows(
    () => lastFinishAgeS("telecast-curate.service", JSON.stringify({ __REALTIME_TIMESTAMP: "1892675500548570" }), now),
    Error,
    "clock",
  );
});

Deno.test("deploy: a web process older than the HEAD reflog serves no known commit", () => {
  assertEquals(servedCommit({ head: "abc", startS: 200, reflogS: 200 }), "abc");
  assertEquals(servedCommit({ head: "abc", startS: 199, reflogS: 200 }), null);
  assertEquals(parseStartS("ExecMainStartTimestamp=@1793518068\n"), 1793518068);
  assertThrows(() => parseStartS("ExecMainStartTimestamp=\n"), Error, "Expected");
  const sha = "e70f926399d4b1a3673ce4ecbb1248fcfbdb7022";
  assertEquals(parseLsRemote(`${sha}\trefs/heads/main\n`), sha);
  assertThrows(() => parseLsRemote(""), Error, "git ls-remote");
});

Deno.test("journal counts: busy lines in the window, distinct visitors", () => {
  assertEquals(countBusy("busy: http://a\nnot busy: x\nbusy:http://b\n"), 2);
  assertEquals(countBusy(""), 0);
  assertEquals(countVisitors("visitor 0123456789abcdef\nvisitor 0123456789abcdef\nvisitor fedcba9876543210\nvisitor short\nx\n"), 2);
});

Deno.test("backupAgeS: a missing file is null and a future mtime throws", () => {
  assertEquals(backupAgeS(null, 1e12), null);
  assertEquals(backupAgeS(1e12 - 5000, 1e12), 5);
  assertThrows(() => backupAgeS(1e12 + 1e7, 1e12), Error, "clock");
});

Deno.test("atJournalCap: a full read may have lost older lines", () => {
  assertEquals(atJournalCap("a\n".repeat(499_999)), false);
  assertEquals(atJournalCap("a\n".repeat(500_000)), true);
});

Deno.test("parseMemory: reads MemoryPeak and MemoryMax, and an unset value throws", () => {
  assertEquals(parseMemory("MemoryPeak=39432192\nMemoryMax=2147483648\n"), { peakBytes: 39432192, maxBytes: 2147483648 });
  assertThrows(() => parseMemory("MemoryPeak=[not set]\nMemoryMax=infinity\n"), Error, "Expected");
});
