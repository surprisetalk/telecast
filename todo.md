- [ ] A YouTube block does not mark its channels as failed, so "At most 20% of channels refreshed in the past 24h failed." scores 1.0.
  - Cause: each night since 30 Oct, from about 23:00 to 07:00 UTC, YouTube answers almost every feed with HTTP 404 or 500. The end matches a
    daily quota that resets at midnight Pacific. `refresh.ts` treats only 429 as transient, so it marks about 40,000 channels failed each
    night. The score was 0.83 on 1 Nov.
  - Decision: no one-time `UPDATE` to clear the 30–31 Oct errors. The block recurs each night, and the next success of each channel clears
    its error.
  1. Add `scripts/refresh.test.ts`. It loads `db.sql` into pgtemp and refreshes 20 YouTube channels whose feeds answer 404 or 500, plus
     channels on another host. Expect no `last_error_at` on the YouTube rows.
  2. In `scripts/refresh.ts`, keep each failure in memory and write the error rows after the pool. A host whose HTTP errors pass 50% of at
     least 20 fetches looks blocked. Skip its HTTP-error rows and log
     `refresh: <host> answered HTTP errors for <n> of <m> feeds, so it looks blocked, not dead`.
- [ ] Tests run their SQL against a real Postgres from pgtemp (`jsr:@surprisetalk/pgtemp`), not against `mockSql`.
  1. `scripts/refresh.test.ts` is the first user (entry above).
  2. Port the `handleSearch` and `handleRssProxy` tests in `functions/test.ts` to pgtemp. Assert rows and responses, not SQL text. Delete
     `mockSql`.
- [ ] A refresh or seed run that meets an unexpected error exits nonzero, and status shows a failed refresh.
  - Decision: `pool()` rejects on the first worker error. The refresh worker already catches each feed error, so pool's catch sees only
    database errors and bugs. Alternative: count failures and exit nonzero past 50%. It hides a database fault in half the rows.
  1. Remove the catch in `scripts/pool.ts`.
  2. Add "Refresh succeeded in the past 15 min." to `scripts/status.ts`, from the journal of `telecast-refresh.service`.
- [ ] The status check fails when pc serves a commit other than origin/main.
  1. In `scripts/status.ts`, the served commit is `git rev-parse HEAD` when `telecast-web` started after the last write to `.git/logs/HEAD`.
     jj appends to that file too. Score 1 when the served commit equals `git ls-remote origin main`, else 0.
- [ ] The public feed and thumb proxies cannot exhaust pc. Today parallel requests to large bodies can pass telecast-web's MemoryMax=2G.
      systemd then kills it, and the site is down for the 30 s RestartSec.
  1. Measure on a local server: 60 parallel `/proxy/rss/` requests to a 45 MB feed, and the peak RSS of the deno process.
  2. If the peak passes 2 GB, cap concurrent upstream fetches with a counter in `server.ts`. Derive the cap from 2 GB and the measured peak
     per request. Past the cap, answer 503 `Busy: <n> feeds are loading. Expected fewer than <n>. Retry in a few seconds.` and log one
     `busy:` line.
  3. Add a status condition on the `busy:` lines of `telecast-web` in the past hour.
- [ ] Status shows how many people used telecast in the past 24h, against a goal of 10.
  1. `server.ts` logs `visitor <hash>` on the first `/search` of each visitor per UTC day. The hash is the first 16 hex digits of sha256 of
     the day and `CF-Connecting-IP`.
  2. Add "10 people used telecast in the past 24h." to `scripts/status.ts`: distinct hashes in the journal of `telecast-web`, over 10.
- [ ] Telecast's database survives the loss of pc.
  - Decision: a nightly `pg_dump -Fc` to `nightly.dump` in the clone. r2-backup copies `~/Developer` to R2 at 03:00 Pacific with the token
    it already holds, and keeps each old version for 30 days. Alternative: a dump on local disk only. It does not survive pc.
  1. Add "pg_dump backed up the database in the past 26 hours." to `scripts/status.ts`, from the mtime of `nightly.dump`.
- [ ] A visitor finds lectures from one chip on the homepage.
  1. Seed tags each channel from `scripts/lectures.json` with `lectures`.
  2. `discoverTags` in `src/Main.elm` gains a `lectures` chip.
- [ ] Seed finds YouTube channel IDs in public GitHub datasets, toward an open YouTube metadata database.
  - Decision: keep it in telecast until a second project reads the data. Alternative: a separate repo now. It costs a second schema.
  1. Search GitHub for datasets of YouTube channel IDs. Pick the largest with a stable raw URL.
  2. Add a `github` source to `gather` in `scripts/seed.ts` that reads it.
- [ ] Seed indexes archive.org feeds.
  - Decision: index feeds, not files. Alternative: mirror the files. It costs petabytes.
  1. Add an `archive` source to `gather` that reads archive.org collection RSS for a fixed list of collections.
- [ ] iOS and TV users open telecast as an app.
  1. Add a web app manifest and an apple-touch-icon, so iOS adds telecast to the home screen.
- [ ] Viewers watch live streams.
  - Decision: live playback first. Comments and ads wait for 10 daily users.
  1. Play `podcast:liveItem` HLS streams in the player.
- [ ] A terminal user browses and plays telecast in a bubbletea TUI.
  1. `tui/` lists `/search?q=tag:featured` and plays an episode with mpv.
- [ ] Every weekly seed run succeeds without Reddit.
  - Decision (Taylor): drop Reddit. Alternative: a Reddit "script" app with `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` in pc's `.env`. It
    keeps Reddit's hand-picked links, but it costs an account and credentials.
  1. Delete `fromReddit`, its source in `gather`, and its tests from `scripts/seed.ts` and `scripts/seed.test.ts`.
  2. `sudo systemctl start telecast-seed`, then confirm `Finished telecast seed.` in the journal.
- [ ] A visitor remixes an episode into a clip with filters, effects, and annotations, and shares it as one link.
  - Example: `/remix?src=<episode src>&t=90,150&filter=grayscale&note=95:Look%20here` plays 1:30 to 2:30 in grayscale, with "Look here" over
    the video from 1:35.
  - Decision: a remix is a URL that the player applies, not a rendered file. Alternative: render each remix with ffmpeg on pc. It costs CPU
    and storage per remix, and visitors choose the input.
  1. Clip: the player plays only `t=<start>,<end>`, and a "clip" button copies the link at the current range.
  2. Filters and effects: a fixed list of CSS `filter` values on the video element, chosen from the URL.
  3. Annotations: timed text overlays from repeated `note=<seconds>:<text>` parameters.

## Blocked on you

- [ ] Visitors load telecast.company from pc, and Neon, Pages, and R2 hold nothing.
  - Decision: ship queue, layer 3 product (projects strategy, `~/Documents/tasks/todo.md`, 27 Oct). It merges into Salt later, and shelob
    fetches its feeds.
  - Decision: `telecast-web` listens on `unix:/run/telecast-web/web.sock`, and the tunnel ingress for `telecast.company` points there.
    systemd `IPAddressDeny` drops its packets to loopback, LAN, tailnet, and link-local, because the proxies fetch any URL.
  - Tradeoff: the site is down when pc is down. Cloudflare still caches static files and thumbs at the edge.
  - Until step 1, Pages serves from Neon, and pc's copy drifts by each channel a visitor adds. Cloudflare also answers the fence probe with
    its own 502, so "The feed proxy cannot reach pc's loopback." scores 0.
  - Taylor does step 1 now. The agent then runs steps 2 to 4.
  1. Taylor removes the `telecast.company` custom domain from Pages, then runs
     `cloudflared tunnel route dns 5fbc95ea-fe6b-42a5-81d7-a038bea896d0 telecast.company`.
  2. `curl -si https://telecast.company/proxy/rss/http%3A%2F%2F127.0.0.1%3A2%2F` prints `Network error fetching ... Timed out after`. Search
     `tag:featured` on telecast.company, and run `deno task status` on pc.
  3. Done when snitch logs telecast as passing: `psql snitch -c "select * from latest where project = 'telecast'"`.
  4. Delete `~/.neon-service` on pc.
  5. Taylor deletes the GitHub secret `DATABASE_URL`, the Pages project, the R2 buckets `rss`, `rss-dev`, `thumb`, `thumb-dev`, and the Neon
     project, and closes the Neon account.
  6. Taylor deletes the Mac clone `~/Developer/telecast`. pc holds the commits, `todo.md`, and both dumps.
- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
