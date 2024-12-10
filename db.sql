create table channel (
    channel_id text not null,
    rss text not null,
    thumb text,
    title text not null,
    description text,
    packs text[],
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (channel_id)
);

create index channel_search_idx on channel 
    using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

create index channel_packs_idx on channel using gin (packs);

create index channel_updated_at_idx on channel (updated_at);

create table episode (
    channel_id text not null,
    episode_id text not null,
    thumb text,
    title text not null,
    description text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (channel_id, episode_id),
    foreign key (channel_id) references channel (channel_id) on delete cascade
);

create index episode_search_idx on episode 
    using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

create index episode_channel_id_idx on episode (channel_id);
