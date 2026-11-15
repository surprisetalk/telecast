create table channel (
  channel_id text not null,
  rss text not null check (rss ilike 'https://%'),
  thumb text check (thumb ilike 'https://%'),
  title text not null,
  description text,
  tags text [],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consecutive_errors integer not null default 0,
  last_error text,
  last_error_at timestamptz,
  last_success_at timestamptz,
  episode_count integer not null default 0,
  latest_episode_at timestamptz,
  avg_duration_seconds integer,
  author text,
  language text, -- TODO:: Rename to lang
  explicit boolean,
  website text,
  categories text [],
  quality integer not null default 0,
  keywords tsvector,
  primary key (channel_id)
)
-- REVIEW: fillfactor 80 leaves room on each page, so a refresh that changes no indexed column updates the row in place (HOT) and
-- writes no index entry. Alternative: the default 100. It saves a fifth of the heap, but most updates then move the row and write
-- every index, GIN included.
with (fillfactor = 80);

create extension if not exists pg_trgm;

create index channel_search_idx on channel using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

create index channel_title_trgm_idx on channel using gin (lower(title) gin_trgm_ops);

create index channel_keywords_idx on channel using gin (keywords);

create index channel_tags_idx on channel using gin (tags);

create index channel_quality_idx on channel (quality desc);

create table episode (
  channel_id text not null,
  episode_id text not null,
  thumb text check (thumb ilike 'https://%'),
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  src text,
  src_type text,
  src_size_bytes bigint,
  duration_seconds integer,
  published_at timestamptz,
  link text,
  season integer,
  episode integer,
  explicit boolean,
  primary key (channel_id, episode_id),
  foreign key (channel_id) references channel (channel_id) on delete cascade
);

-- REVIEW: search.ts takes each channel's newest episode thumb. This index reads them in order and stops at the first match. The
-- old index on channel_id alone read and sorted all of a channel's episodes, about 2 s for the 50 featured channels. Alternative:
-- no index past the primary key, whose channel_id prefix finds the rows but still sorts them.
create index episode_channel_id_published_at_idx on episode (channel_id, published_at desc nulls last);

create index episode_published_at_idx on episode (published_at desc nulls last);
