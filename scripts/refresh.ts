import db from "postgres";
import { Channel, Episode, parse, parseEpisodes } from "../functions/_shared/rss";

const BATCH_SIZE = 500;
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 20;

async function maybeUpgradeToUulf(rss: string): Promise<string> {
  const m = rss.match(/^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[\w-]+)$/);
  if (!m) return rss;
  const uulf = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${m[1]!.slice(2)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(uulf, { method: "HEAD", signal: controller.signal });
    return res.ok ? uulf : rss;
  } catch {
    return rss;
  } finally {
    clearTimeout(timeout);
  }
}

async function pool(items: readonly any[], n: number, work: (item: any) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await work(item);
      } catch (e) {
        console.error(`pool worker swallowed: ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
}

// Language code to tag mapping
const LANGUAGE_MAP: Record<string, string> = {
  en: "english",
  "en-us": "english",
  "en-US": "english",
  "en-gb": "english",
  "en-GB": "english",
  de: "german",
  "de-DE": "german",
  "de-de": "german",
  fr: "french",
  "fr-FR": "french",
  "fr-fr": "french",
  es: "spanish",
  "es-ES": "spanish",
  "es-es": "spanish",
  ja: "japanese",
  "ja-JP": "japanese",
  pt: "portuguese",
  "pt-BR": "portuguese",
  "pt-PT": "portuguese",
  it: "italian",
  "it-IT": "italian",
  nl: "dutch",
  "nl-NL": "dutch",
  ru: "russian",
  "ru-RU": "russian",
  zh: "chinese",
  "zh-CN": "chinese",
  "zh-TW": "chinese",
  ko: "korean",
  "ko-KR": "korean",
  pl: "polish",
  "pl-PL": "polish",
  sv: "swedish",
  "sv-SE": "swedish",
};

function slugTag(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const KEYWORD_TAG_MAP: Record<string, string> = {
  programming: "technology",
  code: "technology",
  coding: "technology",
  javascript: "technology",
  python: "technology",
  rust: "technology",
  typescript: "technology",
  software: "technology",
  developer: "technology",
  computer: "technology",
  linux: "technology",
  docker: "technology",
  ai: "technology",
  ml: "technology",
  gameplay: "games",
  speedrun: "games",
  gaming: "games",
  minecraft: "games",
  playthrough: "games",
  nintendo: "games",
  playstation: "games",
  xbox: "games",
  esports: "games",
  recipe: "food",
  cooking: "food",
  baking: "food",
  kitchen: "food",
  chef: "food",
  cuisine: "food",
  workout: "fitness",
  exercise: "fitness",
  gym: "fitness",
  yoga: "fitness",
  running: "fitness",
  science: "science",
  physics: "science",
  chemistry: "science",
  biology: "science",
  astronomy: "science",
  history: "history",
  historical: "history",
  ancient: "history",
  war: "history",
  music: "music",
  guitar: "music",
  piano: "music",
  concert: "music",
  song: "music",
  album: "music",
  news: "news",
  politics: "politics",
  election: "politics",
  government: "politics",
  film: "film",
  movie: "film",
  cinema: "film",
  director: "film",
  trailer: "film",
  art: "arts",
  painting: "arts",
  drawing: "arts",
  sculpture: "arts",
  gallery: "arts",
  business: "business",
  startup: "business",
  entrepreneur: "business",
  investing: "business",
  finance: "business",
  health: "health",
  medical: "health",
  doctor: "health",
  medicine: "health",
  wellness: "health",
  education: "education",
  tutorial: "education",
  lesson: "education",
  course: "education",
  learn: "education",
  comedy: "comedy",
  funny: "comedy",
  humor: "comedy",
  sketch: "comedy",
  standup: "comedy",
  religion: "religion",
  christianity: "religion",
  bible: "religion",
  prayer: "religion",
  faith: "religion",
};

function inferKeywordTags(episodes: Episode[]): string[] {
  const text = episodes.slice(0, 20).map((e) => `${e.title ?? ""} ${e.description ?? ""}`).join(" ").toLowerCase();
  const hits: Record<string, number> = {};
  for (const [kw, tag] of Object.entries(KEYWORD_TAG_MAP)) {
    const re = new RegExp(`\\b${kw}\\b`, "g");
    const m = text.match(re);
    if (m) hits[tag] = (hits[tag] ?? 0) + m.length;
  }
  return Object.entries(hits).filter(([, n]) => n >= 2).map(([t]) => t);
}

function detectLanguageFromText(episodes: Episode[]): string | null {
  const text = episodes.slice(0, 20).map((e) => e.title ?? "").join(" ");
  if (!text) return null;
  const ranges: Array<[RegExp, string]> = [
    [/[\u3040-\u309f\u30a0-\u30ff]/, "japanese"],
    [/[\uac00-\ud7af]/, "korean"],
    [/[\u4e00-\u9fff]/, "chinese"],
    [/[\u0400-\u04ff]/, "russian"],
    [/[\u0600-\u06ff]/, "arabic"],
    [/[\u0590-\u05ff]/, "hebrew"],
    [/[\u0e00-\u0e7f]/, "thai"],
    [/[\u0900-\u097f]/, "hindi"],
  ];
  let total = text.length;
  for (const [re, tag] of ranges) {
    const m = text.match(new RegExp(re.source, "g"));
    if (m && m.length / total > 0.2) return tag;
  }
  return null;
}

function inferContentTags(episodes: Episode[]): string[] {
  const hasVideo = episodes.some((e) => e.src_type?.startsWith("video/"));
  const hasAudio = episodes.some((e) => e.src_type?.startsWith("audio/"));
  const tags: string[] = [];
  if (hasVideo) tags.push("video");
  if (hasAudio && !hasVideo) tags.push("audio");
  return tags;
}

function languageTag(lang: string | null): string | null {
  if (!lang) return null;
  const base = lang.split("-")[0]?.toLowerCase() ?? "";
  return LANGUAGE_MAP[lang] || LANGUAGE_MAP[base] || null;
}

function inferAllTags(channelInfo: Channel, episodes: Episode[]): string[] {
  const tags: string[] = [];

  if (channelInfo.tags) tags.push(...channelInfo.tags);

  if (channelInfo.categories) tags.push(...channelInfo.categories.map(slugTag).filter(Boolean));

  tags.push(...inferContentTags(episodes));

  const langTag = languageTag(channelInfo.language) ?? detectLanguageFromText(episodes);
  if (langTag) tags.push(langTag);

  if (channelInfo.explicit === true) tags.push("explicit");

  if (!channelInfo.categories || channelInfo.categories.length === 0) {
    tags.push(...inferKeywordTags(episodes));
  }

  return tags;
}

async function main() {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    Deno.exit(1);
  }

  const sql = db(databaseUrl, { max: CONCURRENCY, idle_timeout: 20, connect_timeout: 30 });

  // Get oldest channels (don't update timestamps here - we'll update on success/failure)
  const channels = await sql`
    SELECT * FROM channel
    ORDER BY
      CASE WHEN last_success_at IS NULL AND last_error_at IS NULL THEN 0 ELSE 1 END,
      updated_at
        + random() * interval '1 day' * coalesce(consecutive_errors,0)
        -- TODO: - random() * interval '1 week' * log(1+coalesce(episode_count,0))
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

  await pool(channels, CONCURRENCY, async (channel) => {
    const index = ++completed;
    const shortUrl = channel.rss.replace(/^https?:\/\//, "").slice(0, 50);

    try {
      const fetchUrl = await maybeUpgradeToUulf(channel.rss);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(fetchUrl, {
        headers: { "User-Agent": "Telecasts/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      const channelInfo = parse(text, fetchUrl);
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

      // Infer tags from channel metadata and episodes
      const inferredTags = inferAllTags(channelInfo, episodes);

      // Update channel metadata and stats on success
      await sql`
          UPDATE channel SET
            title = coalesce(${channelInfo.title}, title),
            description = coalesce(${channelInfo.description}, description),
            thumb = coalesce(${channelInfo.thumb}, thumb),
            author = coalesce(${channelInfo.author}, author),
            language = coalesce(${channelInfo.language}, language),
            explicit = coalesce(${channelInfo.explicit}, explicit),
            website = coalesce(${channelInfo.website}, website),
            categories = coalesce(${channelInfo.categories}, categories),
            tags = CASE
              WHEN ${inferredTags}::text[] IS NOT NULL AND array_length(${inferredTags}::text[], 1) > 0
              THEN (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || ${inferredTags}::text[]) AS t)
              ELSE tags
            END,
            consecutive_errors = 0,
            last_error = null,
            last_error_at = null,
            last_success_at = now(),
            updated_at = now(),
            episode_count = (SELECT count(*) FROM episode WHERE channel_id = ${channel.channel_id}),
            latest_episode_at = (SELECT max(published_at) FROM episode WHERE channel_id = ${channel.channel_id}),
            avg_duration_seconds = (SELECT avg(duration_seconds)::integer FROM episode WHERE channel_id = ${channel.channel_id} AND duration_seconds IS NOT NULL),
            keywords = (
              SELECT to_tsvector('english', coalesce(string_agg(title || ' ' || coalesce(description, ''), ' '), ''))
              FROM (
                SELECT title, description FROM episode
                WHERE channel_id = ${channel.channel_id}
                ORDER BY published_at DESC NULLS LAST
                LIMIT 20
              ) e
            ),
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
  });

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

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
