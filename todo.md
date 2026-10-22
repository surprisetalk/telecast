- [ ] telecast.company is served from pc. Postgres listens on localhost only. Neon, Pages, and R2 hold nothing, and Neon is closed.
  - Decision: database `telecast`, role `telecast` with a password, on pc Postgres 18 (done). `pg_trgm` is the only extension.
  - Decision: `telecast-web` on pc listens on `unix:/run/telecast-web/web.sock` (`DENO_SERVE_ADDRESS`), and the tunnel ingress for
    `telecast.company` points there. systemd `IPAddressDeny` drops its packets to loopback, LAN, tailnet, and link-local, because the proxies
    fetch any URL a visitor names. `deno task status` proves the fence: the feed proxy must time out on `http://127.0.0.1:2/`.
  - Decision: everything on pc reaches Postgres on its socket: `.env` holds `DATABASE_URL=postgres:///telecast` plus `PGHOST`, `PGUSER`,
    `PGPASSWORD`. postgres.js reads a socket path only from `PGHOST`. NixOS's default md5 lines still allow TCP from localhost.
  - Decision: R2 became `cache/` (sha256 file names, mtime as age). sharp resizes thumbs to 256 px webp. Bodies cap at 20 MB (thumb)
    and 50 MB (feed).
  - Tradeoff: the site is down when pc is down. Cloudflare still caches static files and thumbs at the edge.
  - Backup: `telecast.dump` (17 Oct) and `neon-2026-10-22.dump` (`pg_dump -Fc` from Neon) in the pc clone, ignored by `*.dump`.
  1. Taylor removes the `telecast.company` custom domain from Pages, then runs
     `cloudflared tunnel route dns 5fbc95ea-fe6b-42a5-81d7-a038bea896d0 telecast.company`. Until then Pages serves from Neon, and pc's
     copy (restored 22 Oct, counts equal) drifts by any channel a visitor adds through Pages.
  2. Search `tag:featured` on telecast.company. Run `deno task status` on pc. When it passes, push main from pc (`git push`), which
     also brings origin up to the commits now only on the Mac and pc.
  3. Done when snitch logs telecast as passing on pc: `psql snitch -c "select * from latest where project = 'telecast'"`.
  4. Delete `~/.neon-service` on pc (Neon credentials for the copy).
  5. Taylor deletes the GitHub secret `DATABASE_URL`, the Pages project, the R2 buckets `rss`, `rss-dev`, `thumb`, `thumb-dev`, and the
     Neon project, and closes the Neon account (~/Documents/tasks/todo.md).
  6. Taylor deletes the Mac clone `~/Developer/telecast` once pc has everything: the commits, `todo.md`, the `*.dump` line in
     `.gitignore`, and both dumps (`telecast.dump`, `neon-2026-10-22.dump`) are on pc already.
- [ ] Seed finds channels on Reddit again. Since Reddit closed unauthenticated `search.json` (403 from any host), every seed run fails.
  - Data: pc `.env` gains `REDDIT_CLIENT_ID=abc123` and `REDDIT_CLIENT_SECRET=xyz789` from a Reddit app of type "script".
  - Flow, in `fromReddit` in `scripts/seed.ts`:
    1. Read both variables. If either is missing, throw (never print a value):
       `Reddit credentials are missing. Expected REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env, from https://www.reddit.com/prefs/apps (type: script). Received: REDDIT_CLIENT_ID missing, REDDIT_CLIENT_SECRET set.`
    2. POST `https://www.reddit.com/api/v1/access_token` with HTTP Basic auth (id:secret) and `grant_type=client_credentials`. Expect
       200 and `{ access_token: string, token_type: "bearer" }`, else throw
       `Reddit token: expected HTTP 200 with a bearer access_token, received 401: {"message": "Unauthorized"}. Check the app's id and secret.`
    3. For each of the 3 queries: GET `https://oauth.reddit.com/search?q=...&limit=100&type=link` with `Authorization: bearer <token>`.
       The listing shape is unchanged, so `linksFromRedditListing` stays. Non-200 throws `Reddit HTTP 429 for "youtube channel"`.
    4. Every request sends Reddit's required User-Agent form: `deno:telecast-seeder:1.1 (by telecast.company)`.
  - Failure: missing or wrong credentials fail the whole seed run (gather already throws on any source), so status shows
    "Seed succeeded in the past 8 days" red until Taylor adds them. `main` warns at startup when either variable is missing.
  - Plain fetch, no library: the flow is one POST and a header, with no token signing or parsing beyond JSON.
  1. Taylor creates the Reddit app and adds both variables to pc's `.env`. Then `sudo systemctl start telecast-seed` and confirm
     `Finished telecast seed.` in the journal.
- [ ] The public feed and thumb proxies cannot exhaust pc. Today each request may buffer 50 MB (feed) or 20 MB (image), with no limit
  on concurrent requests, so parallel requests to large bodies can pass telecast-web's MemoryMax=2G. systemd then kills it, and the site
  is down for the 30 s RestartSec. Three break-it rounds in a row found faults in these open proxies.
  1. Measure first: from outside pc, 60 parallel `/proxy/rss/` requests to a public 45 MB feed-shaped file, and read the unit's memory peak.
  2. If it passes 2 GB, cap concurrent upstream fetches with a counter in `server.ts`. Past the cap, answer 503
     `Busy: <n> feeds are loading. Expected fewer than <n>. Retry in a few seconds.` Add a status condition for 503s per hour.
- [ ] make a database of lectures and download and transcribe and index all of them
- [ ] use jsr:@surprisetalk/pgtemp
- [ ] need better instructions on how to start your own telecast
- [ ] crawl github datasets for as many yt channel ids as possible (seeder is source-pluggable — add a github adapter to scripts/seed.ts)
- [ ] consider making open yt db search project separate
- [ ] telecast remixes
- [ ] ship bubbletea tui
- [ ] support for livestreaming / clubhouse
- [ ] ios/tv app
- [ ] mirror all of archive.org too
- [ ] telecast livestreaming service, comments, and ads hosting
- [ ] need to create an open yt metadata db
- [ ] let's make lectures and technical content and courses a first-class experience
- [ ] get 10 daily active users
- [ ] The status check fails when refresh or seed fails too often. Today `scripts/pool.ts` logs each worker error and the job exits 0.
  1. In `pool()`, count failures and return `{ ok, failed }`. Do not throw: some feed is always dead, so a throw turns every run red.
  2. `refresh.ts` and `seed.ts` exit nonzero when `failed / total` passes 50%. The message names both counts and the first 3 errors.
- [ ] Telecast's database survives losing pc. Today pc has no Postgres backup, and after the cutover the only other copy is the 17 Oct dump.
  1. Pick the target: a nightly `pg_dump -Fc` to local disk (guards bad writes only), or to R2 (needs a token on pc).
