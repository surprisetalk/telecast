# telecast

a minimalist & free youtube alternative [from the future](https://futureofcoding.org)

## api

```bash
GET /search                # search video
GET /proxy/rss/*           # fetch rss feeds
GET /proxy/thumb/*         # cache thumbnails
```

## local dev

```bash
npm run dev-server
npm run dev-client
npx tsx scripts/refresh.ts
```
