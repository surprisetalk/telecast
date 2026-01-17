-- Import video podcast feeds from Podcast Index into Neon PostgreSQL
-- Source: https://public.podcastindex.org/podcastindex_feeds.db.tgz
--
-- Usage:
--   curl -O https://public.podcastindex.org/podcastindex_feeds.db.tgz
--   tar -xzf podcastindex_feeds.db.tgz -C /tmp/
--   sed "s|\$DATABASE_URL|$DATABASE_URL|" import_feeds.sql | duckdb
--
-- Requires: DuckDB with postgres extension, DATABASE_URL env var

-- Attach SQLite source
ATTACH '/tmp/podcastindex_feeds.db' AS src (TYPE sqlite);

-- Install and load Postgres extension
INSTALL postgres;
LOAD postgres;

-- Attach Neon destination
ATTACH '$DATABASE_URL' AS dst (TYPE postgres);

-- Import video feeds with transformations
INSERT INTO dst.channel (channel_id, rss, thumb, title, description, packs, created_at, updated_at)
SELECT
  COALESCE(NULLIF(trim(podcastGuid), ''), CAST(id AS TEXT)) as channel_id,
  regexp_replace(url, '^[Hh][Tt][Tt][Pp]://', 'https://') as rss,
  CASE WHEN imageUrl LIKE 'http%' OR imageUrl LIKE 'Http%'
       THEN regexp_replace(imageUrl, '^[Hh][Tt][Tt][Pp]://', 'https://')
       ELSE NULL END as thumb,
  trim(title) as title,
  NULLIF(trim(description), '') as description,
  list_filter([category1, category2, category3, category4, category5,
               category6, category7, category8, category9, category10],
              x -> x IS NOT NULL AND trim(x) != '') as packs,
  now() as created_at,
  now() as updated_at
FROM src.podcasts
WHERE (newestEnclosureUrl LIKE '%.mp4%'
    OR newestEnclosureUrl LIKE '%.webm%'
    OR newestEnclosureUrl LIKE '%.mov%'
    OR newestEnclosureUrl LIKE '%.m3u8%'
    OR newestEnclosureUrl LIKE '%.mkv%')
AND dead = 0
AND title IS NOT NULL AND trim(title) != ''
ON CONFLICT (channel_id) DO UPDATE SET
  rss = EXCLUDED.rss,
  thumb = EXCLUDED.thumb,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  packs = EXCLUDED.packs,
  updated_at = now();
