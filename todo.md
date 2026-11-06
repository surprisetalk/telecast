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
