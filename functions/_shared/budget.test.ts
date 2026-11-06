import { assertEquals, assertInstanceOf } from "jsr:@std/assert@1";
import { BUDGET, BYTES_PER_PIXEL, withSlot } from "./budget.ts";

const wholeBudgetInPixels = Math.floor((BUDGET - 1) / BYTES_PER_PIXEL);

Deno.test("withSlot: a reserve that wakes after its handler returned adds nothing", async () => {
  const release = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  // The older request holds a little. The younger one takes the whole budget and keeps it until released.
  const orphan = Promise.withResolvers<Promise<unknown>>();
  const older = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(1000);
    hold.resolve();
    await release.promise;
    // Return while this reserve still waits for room, as a fetch timeout does.
    orphan.resolve(reservePixels(1000).catch((e) => e));
    return new Response("older");
  });
  await hold.promise;
  const younger = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels - 1500);
    release.resolve();
    // Wait until the older handler has returned, then free the budget the orphan reserve is waiting for.
    await orphan.promise;
    await new Promise((r) => setTimeout(r, 50));
    return new Response("younger");
  });
  const [olderRes, youngerRes] = await Promise.all([older, younger]);
  assertEquals([olderRes.status, youngerRes.status], [200, 200]);
  assertInstanceOf(await (await orphan.promise), Error);
  // Nothing is left over, so one request can take the whole budget.
  const whole = await withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels);
    return new Response("whole");
  });
  assertEquals(whole.status, 200);
});

Deno.test("withSlot: an older request that waits for room evicts a younger one, which answers 503 at its next reserve", async () => {
  const olderHolds = Promise.withResolvers<void>();
  const youngerHolds = Promise.withResolvers<void>();
  const older = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(1000);
    olderHolds.resolve();
    await youngerHolds.promise;
    // About 2000 pixels are free, so this waits for room.
    await reservePixels(4000);
    return new Response("older");
  });
  await olderHolds.promise;
  const younger = withSlot(1, async ({ reservePixels }) => {
    await reservePixels(wholeBudgetInPixels - 3000);
    youngerHolds.resolve();
    await new Promise((r) => setTimeout(r, 50));
    // One pixel fits in the free room. Only the eviction refuses it.
    await reservePixels(1);
    return new Response("younger");
  });
  const [olderRes, youngerRes] = await Promise.all([older, younger]);
  assertEquals([olderRes.status, youngerRes.status], [200, 503]);
});
