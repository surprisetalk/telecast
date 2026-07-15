# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

```bash
npm run dev-server    # Wrangler Pages dev server (localhost:8788)
npm run dev-client    # Elm watch/compile with debug mode
elm make src/Main.elm --output=public/elm.js  # Production build
npx tsx scripts/refresh.ts  # Batch refresh feeds (runs via GitHub Actions every 5 min)
deno run -A scripts/seed.ts --source=all --dry-run    # Discover new channels (weekly CI)
deno run -A scripts/curate.ts --dry-run               # Assign tag:featured (daily CI)
```

Requires `.env` with `DATABASE_URL` (Neon PostgreSQL connection string). Deno scripts (`scripts/*.ts`, `functions/`) are
checked/tested/formatted with `deno check|test|fmt`.

## Architecture

Telecasts is a podcast/video feed aggregator with:

- **Frontend** (`src/Main.elm`): Elm 0.19.1 SPA with localStorage ports for library persistence
- **Backend** (`functions/`): Cloudflare Workers (TypeScript) with R2 caching
- **Database**: Neon PostgreSQL (schema in `db.sql`)

### Endpoints

| Route                   | Handler                             | Purpose                                      |
| ----------------------- | ----------------------------------- | -------------------------------------------- |
| `/search`               | `functions/search.ts`               | Full-text search via PostgreSQL `to_tsquery` |
| `/proxy/rss/[[path]]`   | `functions/proxy/rss/[[path]].ts`   | RSS/Atom/RDF fetch, parse, cache             |
| `/proxy/thumb/[[path]]` | `functions/proxy/thumb/[[path]].ts` | Image proxy with R2 cache                    |

### Feed Formats

Supports RSS 2.0, Atom, RDF, and YouTube channel feeds. Feed parsing logic in `functions/_shared/rss.ts`.

### Data Flow

1. User subscribes to RSS URL → stored in localStorage via Elm ports
2. Frontend requests `/proxy/rss/{url}` → Worker fetches/caches feed, upserts to PostgreSQL
3. Episodes render in middle column → playback tracked client-side

### R2 Buckets

Workers use two R2 bindings (see `wrangler.toml`):

- `BUCKET_RSS` - cached feed XML
- `BUCKET_THUMB` - cached channel/episode images

### Search

Full-text search uses PostgreSQL `to_tsquery`. Special syntax: `tag:{tag_name}` filters channels by tag membership (channels have a
`tags text[]` column).

### Curation & Discovery

- **Tags** are inferred by `scripts/refresh.ts` (`KEYWORD_TAG_MAP` → coarse + fine-grained tags, language, content type, iTunes categories).
  The fine-grained tags match the `discoverTags` chips in `Main.elm`.
- **`tag:featured`** drives the homepage bar (`Main.elm` loads `/search?q=tag:featured`). It is assigned by `scripts/curate.ts`:
  auto-promote top-N channels per topic tag by `quality`, plus `featuredPin` / minus `blocked` from `scripts/curation.json`. The pass is
  idempotent and self-syncing (removes `featured` from channels no longer selected).
- **Seeding** new channels: `scripts/seed.ts` mines YouTube channel links from Hacker News (Algolia API) + Reddit and reads
  `scripts/lectures.json` (curated MOOC/lecture channels), resolves them via `functions/_shared/youtube.ts`, and inserts rows
  (`on conflict do nothing`). `refresh.ts` then fills in episodes/tags/quality.

### Scripts & CI

`scripts/refresh.ts` (feeds, every 5 min), `scripts/seed.ts` (discovery, weekly), `scripts/curate.ts` (featured, daily) — each has a GitHub
Actions workflow in `.github/workflows/`. Shared helpers: `scripts/pool.ts` (concurrency), `functions/_shared/rss.ts` (parsing),
`functions/_shared/youtube.ts` (channel-URL → feed-URL resolution, shared with the RSS proxy).

## Elm Frontend

### Core Types

```elm
type alias Library = { channels, episodes, history, settings }
type alias Channel = { title, description, thumb, rss, updatedAt }
type alias Episode = { id, title, thumb, src, description }
type alias Playback = { t : Time.Posix, s : (current, duration) }
```

### Ports

Two-way localStorage sync:

- `libraryLoaded` (incoming) - receives library on load
- `librarySaving` (outgoing) - persists library on change

### Loading Pattern

```elm
type Loadable a = Loadable (Maybe (Result String a))
```

Used for channels/episodes that may be unloaded, loading, loaded, or errored.

## Code Style

Prettier: 2-space indent, 140 char width, no semicolons in Elm (standard)
