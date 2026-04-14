-- Seed channel table with YouTube channels from public datasets
-- Sources:
--   YouNiverse (EPFL):    https://zenodo.org/records/4650046/files/df_channels_en.tsv.gz
--   YouTube-Commons meta: https://huggingface.co/datasets/Pclanglais/youtube-commons-metadata
--
-- Usage:
--   curl -L 'https://zenodo.org/records/4650046/files/df_channels_en.tsv.gz?download=1' -o /tmp/younivere.tsv.gz
--   sed "s|\$DATABASE_URL|$DATABASE_URL|" scripts/seed-youtube.sql | duckdb
--
-- Requires: DuckDB with postgres + httpfs extensions, DATABASE_URL env var

INSTALL postgres; LOAD postgres;
INSTALL httpfs;   LOAD httpfs;

ATTACH '$DATABASE_URL' AS dst (TYPE postgres);

-- Stage YouNiverse: rich metadata (name + category)
CREATE TEMP TABLE yn AS
SELECT
  channel        AS channel_id,
  name_cc        AS title,
  category_cc    AS category
FROM read_csv_auto('/tmp/younivere.tsv.gz', delim='\t')
WHERE channel LIKE 'UC%' AND length(channel) = 24;

-- Stage YouTube-Commons: ID-only, dedup
CREATE TEMP TABLE ytc AS
SELECT DISTINCT channel_id
FROM read_parquet('https://huggingface.co/datasets/Pclanglais/youtube-commons-metadata/resolve/main/youtube_commons_2.parquet')
WHERE channel_id LIKE 'UC%' AND length(channel_id) = 24;

-- Union, prefer YouNiverse metadata
CREATE TEMP TABLE seed AS
SELECT
  yn.channel_id,
  COALESCE(NULLIF(trim(yn.title), ''), 'YouTube channel') AS title,
  CASE WHEN yn.category IS NOT NULL AND trim(yn.category) != ''
       THEN ['video', lower(trim(yn.category))]
       ELSE ['video']
  END AS tags
FROM yn
UNION ALL
SELECT
  ytc.channel_id,
  'YouTube channel' AS title,
  ['video'] AS tags
FROM ytc
WHERE ytc.channel_id NOT IN (SELECT channel_id FROM yn);

-- Push to Postgres; new rows only — refresh.ts hydrates the rest
INSERT INTO dst.channel (channel_id, rss, title, tags, consecutive_errors, episode_count, quality, created_at, updated_at)
SELECT
  channel_id,
  'https://www.youtube.com/feeds/videos.xml?channel_id=' || channel_id AS rss,
  title,
  tags,
  0, 0, 0,
  now(),
  now()
FROM seed
ON CONFLICT (channel_id) DO NOTHING;

SELECT count(*) AS yt_channels_total
FROM dst.channel
WHERE rss LIKE 'https://www.youtube.com/feeds/videos.xml%';
