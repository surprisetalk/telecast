## local dev

prereqs: `postgresql`, `postgresql-client`, `postgresql-contrib`, & neon [console ](https://console.neon.tech/)

`.env`: `.env.example`

```bash
psql $DATABASE_URL -f db.sql
npm run dev-server
npm run dev-client
npx tsx --env-file .env scripts/refresh.ts
```
