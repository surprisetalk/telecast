import db from "postgres";
import { parseEpisodes } from "../functions/_shared/rss";

const BATCH_SIZE = 100;

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
      ORDER BY updated_at ASC
      LIMIT ${BATCH_SIZE}
    )
    RETURNING *
  `;

  console.log(`Processing ${channels.length} channels...`);

  let processed = 0;
  const errors: { channel_id: string; error: string }[] = [];

  await Promise.all(
    channels.map(async channel => {
      try {
        const res = await fetch(channel.rss, {
          headers: { "User-Agent": "Telecasts/1.0" },
        });
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
        processed++;
      } catch (e) {
        errors.push({
          channel_id: channel.channel_id,
          error: (e as Error).message,
        });
      }
    }),
  );

  console.log(`Processed: ${processed}/${channels.length}`);
  if (errors.length > 0) {
    console.log(`Errors:`, errors);
  }

  await sql.end();
}

main();
