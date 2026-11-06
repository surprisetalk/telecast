# telecast

a minimalist & free youtube alternative

## api

```bash
GET /search                # search video
GET /proxy/rss/*           # fetch rss feeds
GET /proxy/thumb/*         # cache thumbnails
```

## Run your own

prereqs: `postgresql` with `postgresql-contrib`, `deno`, `node`

```bash
git clone https://github.com/surprisetalk/telecast && cd telecast
cp .env.example .env    # set DATABASE_URL
createdb telecast && psql telecast -f db.sql
npm ci
npx elm make src/Main.elm --optimize --output=public/elm.js
deno task serve         # http://127.0.0.1:8047
```

The database starts empty. Seed channels, feature the picks in `scripts/curation.json`, then refresh feeds every 5 minutes, e.g. from cron:

```bash
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/seed.ts
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/curate.ts
*/5 * * * * cd ~/telecast && deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts
```

The feed and thumb proxies fetch any URL a visitor names. Before you expose the server, block its packets to loopback and your LAN. pc does
it with systemd `IPAddressDeny`; claude.md describes the fence.

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
# refresh feeds: fetch episodes, infer tags, recompute quality (every 5 min on pc: telecast-refresh.timer)
deno run --env-file=.env --allow-net --allow-env --allow-read --allow-sys scripts/refresh.ts

# seed new channels from HN, GitHub, archive.org, and scripts/lectures.json (Mondays 05:00 UTC on pc: telecast-seed.timer)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/seed.ts --dry-run

# curate: sync tag:featured to scripts/curation.json priority minus blocked (06:00 UTC on pc: telecast-curate.timer)
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/curate.ts --dry-run

# production status: site, feed freshness, refresh error rate, curate/seed runs, DB size; exits 1 when any score is below 1.0
deno task status
```

Drop `--dry-run` to write. `scripts/curation.json` is the hand-editable curation surface: `priority` (always-featured human picks),
`blocked` (never featured). Featured = `priority` minus `blocked`. `scripts/lectures.json` holds curated MOOC/lecture channel URLs for the
seeder.
