# telecast

a minimalist & free youtube alternative

## api

```bash
GET /search                # search video
GET /proxy/rss/*           # fetch rss feeds
GET /proxy/thumb/*         # cache thumbnails
```

## local dev

prereqs: `postgresql`, `postgresql-client`, `postgresql-contrib`, & neon [console ](https://console.neon.tech/)

`.env`: `.env.example`

```bash
psql $DATABASE_URL -f db.sql
npm run dev-server
npm run dev-client
npx tsx --env-file .env scripts/refresh.ts
```
