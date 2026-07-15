# telecast

a minimalist & free youtube alternative

## api

```bash
GET /search                # search video
GET /proxy/rss/*           # fetch rss feeds
GET /proxy/thumb/*         # cache thumbnails
```

## local dev

prereqs: `postgresql`, `postgresql-client`, `postgresql-contrib`, & neon [console](https://console.neon.tech/)

`.env`: `.env.example`

```bash
psql $DATABASE_URL -f db.sql
npm run dev-server
npm run dev-client
deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts
```

## batch scripts

```bash
# refresh feeds: fetch episodes, infer tags, recompute quality (every 5 min via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts

# seed new channels from HN + Reddit links and scripts/lectures.json (weekly via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/seed.ts --source=all --dry-run

# curate: auto-promote top channels per topic to tag:featured, honoring scripts/curation.json (daily via CI)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/curate.ts --dry-run
```

Drop `--dry-run` to write. `scripts/curation.json` is the hand-editable curation surface: `priority` (always-featured human picks),
`blocked` (never featured), and `autoPromote` + `perTagLimit`/`minQuality` for optional algorithmic top-N-per-tag fill (off by default — the
`quality` score over-rewards prolific feeds). `scripts/lectures.json` holds curated MOOC/lecture channel URLs for the seeder.
