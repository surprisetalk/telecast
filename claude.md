# claude.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

```bash
deno task serve       # server.ts on 127.0.0.1:8047: public/, /search, and the proxies
npm run dev-client    # Elm watch/compile with debug mode
elm make src/Main.elm --output=public/elm.js  # Production build
deno run -A scripts/refresh.ts  # Batch refresh feeds (runs via GitHub Actions every 5 min)
deno run -A scripts/seed.ts --dry-run    # Discover new channels (weekly CI)
deno run -A scripts/curate.ts --dry-run               # Assign tag:featured (daily CI)
deno task status                                      # Production status; snitch runs it hourly on the mac
```

Requires `.env` with `DATABASE_URL`, a postgres URL. postgres.js reads a unix socket only from `PGHOST`, so the socket form is
`DATABASE_URL=postgres:///telecast` plus `PGHOST`, `PGUSER`, and `PGPASSWORD`. Deno code (`server.ts`, `functions/`, `scripts/`) is
checked/tested/formatted with `deno check|test|fmt`. Tests run with `-A`; `server.test.ts` starts the server with the flags of
`deno task serve`, so a missing permission fails the suite.

## Architecture

Telecasts is a podcast/video feed aggregator with:

- **Frontend** (`src/Main.elm`): Elm 0.19.1 SPA with localStorage ports for library persistence
- **Backend** (`server.ts`, handlers in `functions/`): `deno serve`, with feed and thumb caches on disk in `cache/`
- **Database**: PostgreSQL (schema in `db.sql`)

### Endpoints

| Route                   | Handler                             | Purpose                                      |
| ----------------------- | ----------------------------------- | -------------------------------------------- |
| `/search`               | `functions/search.ts`               | Full-text search via PostgreSQL `to_tsquery` |
| `/proxy/rss/[[path]]`   | `functions/proxy/rss/[[path]].ts`   | RSS/Atom/RDF fetch, parse, cache             |
| `/proxy/thumb/[[path]]` | `functions/proxy/thumb/[[path]].ts` | Image proxy: sharp resize to 256 px webp     |

### Feed Formats

Supports RSS 2.0, Atom, RDF, and YouTube channel feeds. Feed parsing logic in `functions/_shared/rss.ts`.

### Data Flow

1. User subscribes to RSS URL → stored in localStorage via Elm ports
2. Frontend requests `/proxy/rss/{url}` → Worker fetches/caches feed, upserts to PostgreSQL
3. Episodes render in middle column → playback tracked client-side

### Caches and limits

`functions/_shared/cache.ts` keeps one file per key in `cache/rss` and `cache/thumb`: the name is the key's sha256, and the mtime is
the write time. The server deletes files older than 7 days at startup and each hour. Visitors choose the URLs, so every limit is a
constant in the handler: only http and https, 50 MB per feed, 20 MB and 25 megapixels per image.

### Production

The home server pc runs `deno task serve` as the systemd unit `telecast-web` (config: `surprisetalk/pc`, `/etc/nixos/flake.nix`).
cloudflared serves `telecast.company` from the unit's unix socket. systemd drops the unit's packets to loopback, LAN, and tailnet,
because the proxies fetch any URL. `deno task status` checks that fence and fails when it stops dropping. A pull of this repo on pc
rebuilds `public/elm.js` and restarts the unit.

### Search

Full-text search uses PostgreSQL `to_tsquery`. Special syntax: `tag:{tag_name}` filters channels by tag membership (channels have a
`tags text[]` column).

### Curation & Discovery

- **Tags** are inferred by `scripts/refresh.ts` (`KEYWORD_TAG_MAP` → coarse + fine-grained tags, language, content type, iTunes categories).
  The fine-grained tags match the `discoverTags` chips in `Main.elm`.
- **`tag:featured`** drives the homepage bar (`Main.elm` loads `/search?q=tag:featured`). It is human-curated: `scripts/curate.ts` syncs the
  `featured` tag to `scripts/curation.json` `priority` minus `blocked`. The pass is idempotent and
  self-syncing, so hand-picks must live in `priority` to survive.
  `search.ts` also shows `tag:featured` by recent content (not gated/ordered by the broken `quality` score, unlike other tag pages).
- **Seeding** new channels: `scripts/seed.ts` mines YouTube channel links from Hacker News (Algolia API) + Reddit and reads
  `scripts/lectures.json` (curated MOOC/lecture channels), resolves them via `functions/_shared/youtube.ts`, and inserts rows
  (`on conflict do nothing`). `refresh.ts` then fills in episodes/tags/quality.

### Scripts & CI

`scripts/refresh.ts` (feeds, every 5 min), `scripts/seed.ts` (discovery, weekly), `scripts/curate.ts` (featured, daily) — each has a GitHub
Actions workflow in `.github/workflows/`. Shared helpers: `scripts/pool.ts` (concurrency), `functions/_shared/rss.ts` (parsing), `functions/_shared/body.ts` (capped body reads),
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

`deno fmt` (config in deno.json): 2-space indent, 140 char width. Elm has no semicolons.
