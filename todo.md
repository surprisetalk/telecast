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
- [ ] Seed resolves YouTube links outside YouTube's nightly block.
  - Cause: `telecast-seed.timer` fires Mondays at 05:00 UTC, inside the block from about 23:00 to 07:00 UTC, so YouTube answers its resolves
    with 404 or 500.
  1. In `/etc/nixos/flake.nix`, move the timer to `Mon *-*-* 09:00:00 UTC`, and update the seed line in `readme.md`.
- [ ] The GitHub seed source reads a licensed dataset.
  - `chen-zhitao/Youtube-Channels-Dataset` has no license. Seed reads only its channel IDs, which are facts, and stores no descriptions.
  1. Search again for a channel-ID dataset under an open license (CC0, CC-BY, ODbL), and swap `GITHUB_URL` when one turns up.
- [ ] The TUI reads episodes that `functions/_shared/rss.ts` parsed, not raw feed XML.
  - Example: `GET /episodes/https%3A%2F%2Fexample.com%2Ffeed.xml` answers `[{"title":"Ep 1","src":"https://example.com/1.mp3"}]`.
  - Cause: three break rounds of the TUI's Go feed decoder each found a feed quirk that rss.ts already handles: XML namespaces, Atom
    hrefs, Latin-1 charsets, and extra links.
  - Decision: `/proxy/rss/` keeps its XML for the Elm app, and `/episodes/` answers the rows of rss.ts `parseEpisodes` as JSON.
    Alternative: keep the Go parser. It costs one fix per feed quirk, in a second parser.
  1. Add `/episodes/` to `server.ts`, through the same memory budget and cache as `/proxy/rss/`, with a test in `server.test.ts`.
  2. In `tui/main.go`, read `/episodes/` and decode its JSON into the checked `{title, src}` record. Delete the XML structs, the charset
     reader, and their tests.
- [ ] The remix player receives only a src that the remix decoder checked.
  - Cause: three break rounds each found a gap between the text the decoder checked and the value the player used: a query parameter
    that `Url.Parser` dropped, a `youtube` substring match, a float that `String.fromFloat` printed as `1e-7`, and a `..` path.
  1. In `src/Main.elm`, build the player src from the decoded `Remix`, parse that exact string again with `Url.fromString`, and show the
     remix error when it differs from the checked value.

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
