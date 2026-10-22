# telecast

a minimalist & free youtube alternative

## api

```bash
GET /search                # search video
GET /proxy/rss/*           # fetch rss feeds
GET /proxy/thumb/*         # cache thumbnails
```

## local dev

prereqs: `postgresql`, `postgresql-client`, `postgresql-contrib`, `deno`, `node`

`.env`: `.env.example`

```bash
git config core.hooksPath .githooks
npm ci
psql $DATABASE_URL -f db.sql
deno task serve      # http://127.0.0.1:8047
npm run dev-client
deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts
```

## batch scripts

```bash
# refresh feeds: fetch episodes, infer tags, recompute quality (every 5 min via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts

# seed new channels from HN + Reddit links and scripts/lectures.json (weekly via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/seed.ts --dry-run

# curate: sync tag:featured to scripts/curation.json priority minus blocked (daily via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/curate.ts --dry-run

# production status: site, feed freshness, refresh error rate, curate/seed runs, DB size; exits 1 when any score is below 1.0
deno task status
```

Drop `--dry-run` to write. `scripts/curation.json` is the hand-editable curation surface: `priority` (always-featured human picks),
`blocked` (never featured). Featured = `priority` minus `blocked`. `scripts/lectures.json` holds curated MOOC/lecture channel URLs for the seeder.
