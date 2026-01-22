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

  // Get oldest channels (don't update timestamps here - we'll update on success/failure)
  const channels = await sql`
    SELECT * FROM channel
    ORDER BY 
      updated_at 
        + random() * interval '1 day' * consecutive_errors
        - random() * interval '1 week' * log(1+coalesce(episode_count,0))
        -- TODO: - random() * interval '1 month' * coalesce((latest_episode_at-first_episode_at)/interval '1 year',0)
        nulls first, 
      random()
    LIMIT ${BATCH_SIZE}
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
                src = EXCLUDED.src,
                src_type = EXCLUDED.src_type,
                src_size_bytes = EXCLUDED.src_size_bytes,
                duration_seconds = EXCLUDED.duration_seconds,
                published_at = EXCLUDED.published_at,
                link = EXCLUDED.link,
                season = EXCLUDED.season,
                episode = EXCLUDED.episode,
                explicit = EXCLUDED.explicit,
                updated_at = now()
          `;
        }

        // Update channel stats on success
        await sql`
          UPDATE channel SET
            consecutive_errors = 0,
            last_error = null,
            last_error_at = null,
            last_success_at = now(),
            updated_at = now(),
            episode_count = (SELECT count(*) FROM episode WHERE channel_id = ${channel.channel_id}),
            latest_episode_at = (SELECT max(published_at) FROM episode WHERE channel_id = ${channel.channel_id}),
            avg_duration_seconds = (SELECT avg(duration_seconds)::integer FROM episode WHERE channel_id = ${channel.channel_id} AND duration_seconds IS NOT NULL),
            quality = (
              SELECT GREATEST(0, LEAST(100, (
                -- Freshness: 0-40 points (linear decay over 2 years)
                CASE
                  WHEN max(published_at) IS NULL THEN 0
                  ELSE GREATEST(0, 40 - EXTRACT(EPOCH FROM (NOW() - max(published_at))) / 86400 / 730 * 40)
                END
                -- Volume: 0-30 points (logarithmic)
                + LEAST(30, LN(1 + count(*)) * 7.5)
                -- Reliability: 20 points (no errors in this success path)
                + 20
                -- Depth: 0-10 points
                + CASE
                    WHEN AVG(duration_seconds) IS NULL THEN 5
                    WHEN AVG(duration_seconds) >= 1800 THEN 10
                    WHEN AVG(duration_seconds) >= 600 THEN 7
                    ELSE 3
                  END
              )))::integer
              FROM episode WHERE channel_id = ${channel.channel_id}
            )
          WHERE channel_id = ${channel.channel_id}
        `;

        succeeded++;
        console.log(`[${index}/${total}] ✓ ${shortUrl} (${episodes.length} episodes)`);
      } catch (e) {
        const msg = (e as Error).name === "AbortError" ? "Request timed out" : (e as Error).message;
        const isRateLimit = msg === "HTTP 429";

        // Track errors (excluding rate-limits which are transient)
        if (!isRateLimit) {
          await sql`
            UPDATE channel SET
              consecutive_errors = consecutive_errors + 1,
              last_error = ${msg},
              last_error_at = now(),
              updated_at = now(),
              quality = (
                SELECT GREATEST(0, LEAST(100, (
                  -- Freshness: 0-40 points (linear decay over 2 years)
                  CASE
                    WHEN max(published_at) IS NULL THEN 0
                    ELSE GREATEST(0, 40 - EXTRACT(EPOCH FROM (NOW() - max(published_at))) / 86400 / 730 * 40)
                  END
                  -- Volume: 0-30 points (logarithmic)
                  + LEAST(30, LN(1 + count(*)) * 7.5)
                  -- Reliability: 0-20 points (penalty based on new error count)
                  + CASE
                      WHEN ${channel.consecutive_errors + 1} = 0 THEN 20
                      WHEN ${channel.consecutive_errors + 1} = 1 THEN 10
                      ELSE 0
                    END
                  -- Depth: 0-10 points
                  + CASE
                      WHEN AVG(duration_seconds) IS NULL THEN 5
                      WHEN AVG(duration_seconds) >= 1800 THEN 10
                      WHEN AVG(duration_seconds) >= 600 THEN 7
                      ELSE 3
                    END
                )))::integer
                FROM episode WHERE channel_id = ${channel.channel_id}
              )
            WHERE channel_id = ${channel.channel_id}
          `;
        }

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
