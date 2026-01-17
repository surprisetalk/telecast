create table channel (
  channel_id text not null,
  rss text not null check (rss ilike 'https://%'),
  thumb text check (thumb ilike 'https://%'),
  title text not null,
  description text,
  packs text [],
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
  primary key (channel_id)
);

create index channel_search_idx on channel using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

create index channel_packs_idx on channel using gin (packs);

create index channel_updated_at_idx on channel (updated_at);

create index channel_consecutive_errors_idx on channel (consecutive_errors);

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

create index episode_search_idx on episode using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

create index episode_channel_id_idx on episode (channel_id);

create index episode_published_at_idx on episode (published_at desc nulls last);
