import db from "postgres";
import { parseEpisodes } from "../functions/_shared/rss";

const BATCH_SIZE = 250;
const FETCH_TIMEOUT_MS = 15_000;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const sql = db(databaseUrl);

  // Get oldest channels and update their timestamps atomically
  const channels = await sql`
    UPDATE channel
    SET updated_at = now()
    WHERE channel_id IN (
      SELECT channel_id FROM channel
      ORDER BY updated_at + random() * interval '2 days' ASC
      LIMIT ${BATCH_SIZE}
    )
    RETURNING *
  `;

  const total = channels.length;
  console.log(`Processing ${total} channels...\n`);

  let completed = 0;
  let succeeded = 0;
  const failures: { rss: string; error: string }[] = [];

  await Promise.all(
    channels.map(async channel => {
      const index = ++completed;
      const shortUrl = channel.rss.replace(/^https?:\/\//, "").slice(0, 50);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(channel.rss, {
          headers: { "User-Agent": "Telecasts/1.0" },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();
        const episodes = parseEpisodes(text, channel.channel_id);

        if (episodes.length > 0) {
          await sql`
            INSERT INTO episode ${sql(episodes)}
            ON CONFLICT (channel_id, episode_id) DO UPDATE
            SET title = EXCLUDED.title,
                description = EXCLUDED.description,
                thumb = EXCLUDED.thumb,
                updated_at = now()
          `;
        }

        succeeded++;
        console.log(`[${index}/${total}] ✓ ${shortUrl} (${episodes.length} episodes)`);
      } catch (e) {
        const msg = (e as Error).name === "AbortError" ? "Request timed out" : (e as Error).message;
        failures.push({ rss: channel.rss, error: msg });
        console.log(`[${index}/${total}] ✗ ${shortUrl} → ${msg}`);
      }
    }),
  );

  // Summary
  console.log(`\nDone: ${succeeded} succeeded, ${failures.length} failed`);

  if (failures.length > 0) {
    console.log("\nFailed:");
    for (const f of failures) {
      const shortUrl = f.rss.replace(/^https?:\/\//, "");
      console.log(`  • ${shortUrl} → ${f.error}`);
    }
  }

  await sql.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
