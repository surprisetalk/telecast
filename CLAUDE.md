# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Development

```bash
npm run dev-server    # Wrangler Pages dev server (localhost:8788)
npm run dev-client    # Elm watch/compile with debug mode
elm make src/Main.elm --output=public/elm.js  # Production build
```

Requires `.env` with `DATABASE_URL` (Neon PostgreSQL connection string).

## Architecture

Telecasts is a podcast/video feed aggregator with:

- **Frontend** (`src/Main.elm`): Elm 0.19.1 SPA with localStorage ports for
  library persistence
- **Backend** (`functions/`): Cloudflare Workers (TypeScript) with R2 caching
- **Database**: Neon PostgreSQL (schema in `db.sql`)

### Endpoints

| Route                   | Handler                             | Purpose                                      |
| ----------------------- | ----------------------------------- | -------------------------------------------- |
| `/search`               | `functions/search.ts`               | Full-text search via PostgreSQL `to_tsquery` |
| `/proxy/rss/[[path]]`   | `functions/proxy/rss/[[path]].ts`   | RSS/Atom/RDF fetch, parse, cache             |
| `/proxy/thumb/[[path]]` | `functions/proxy/thumb/[[path]].ts` | Image proxy with R2 cache                    |

### Feed Formats

Supports RSS 2.0, Atom, RDF, and YouTube channel feeds. Feed parsing logic in
`functions/_shared/rss.ts`.

### Data Flow

1. User subscribes to RSS URL → stored in localStorage via Elm ports
2. Frontend requests `/proxy/rss/{url}` → Worker fetches/caches feed, upserts to
   PostgreSQL
3. Episodes render in middle column → playback tracked client-side

## Code Style

Prettier: 2-space indent, 140 char width, no semicolons in Elm (standard)
