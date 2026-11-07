- [ ] Seed resolves YouTube links outside YouTube's nightly block.
  - Cause: `telecast-seed.timer` fires Mondays at 05:00 UTC, inside the block from about 23:00 to 07:00 UTC, so YouTube answers its resolves
    with 404 or 500.
  1. In `/etc/nixos/flake.nix`, move the timer to `Mon *-*-* 09:00:00 UTC`, and update the seed line in `readme.md`.
- [ ] The GitHub seed source reads a licensed dataset.
  - `chen-zhitao/Youtube-Channels-Dataset` has no license. Seed reads only its channel IDs, which are facts, and stores no descriptions.
  1. Search again for a channel-ID dataset under an open license (CC0, CC-BY, ODbL), and swap `GITHUB_URL` when one turns up.
- [ ] The TUI reads episodes that `functions/_shared/rss.ts` parsed, not raw feed XML.
  - Example: `GET /episodes/https%3A%2F%2Fexample.com%2Ffeed.xml` answers `[{"title":"Ep 1","src":"https://example.com/1.mp3"}]`.
  - Cause: three break rounds of the TUI's Go feed decoder each found a feed quirk that rss.ts already handles: XML namespaces, Atom hrefs,
    Latin-1 charsets, and extra links. Review also found that an RDF feed decodes to zero items with no error.
  - Decision: `/proxy/rss/` keeps its XML for the Elm app, and `/episodes/` answers the rows of rss.ts `parseEpisodes` as JSON. Alternative:
    keep the Go parser. It costs one fix per feed quirk, in a second parser.
  1. Add `/episodes/` to `server.ts`, through the same memory budget and cache as `/proxy/rss/`, with a test in `server.test.ts`.
  2. In `tui/main.go`, read `/episodes/` and decode its JSON into the checked `{title, src}` record. Delete the XML structs, the charset
     reader, and their tests.
- [ ] A visitor who meets a 503 Busy gets the feed or thumb a few seconds later, without a reload.
  - Today `src/Main.elm` shows `Server error: 503` for a feed and leaves a broken thumb until reload.
  1. Retry a `/proxy/rss/` answer of 503 once after 3 s. If it fails again, show the Busy body, which says what is loading.
  2. On a thumb's `error`, retry its src once after 3 s, with CSS for the waiting state.
- [ ] The pre-commit hook and CI run `deno lint`.
  1. In `deno.json`, exclude `no-import-prefix`: the inline `jsr:` and `npm:` imports are this repo's style. Fix the rest, which
     `deno lint server.ts server.test.ts functions/ scripts/` prints, then add that command to `.githooks/pre-commit` and `ci.yml`.

## Blocked on you

- [ ] Visitors load telecast.company from pc, and Neon, Pages, and R2 hold nothing.
  - Decision: ship queue, layer 3 product (projects strategy, `~/Documents/tasks/todo.md`, 27 Oct). It merges into Salt later, and shelob
    fetches its feeds.
  - Decision: `telecast-web` listens on `unix:/run/telecast-web/web.sock`, and the tunnel ingress for `telecast.company` points there.
    systemd `IPAddressDeny` drops its packets to loopback, LAN, tailnet, and link-local, because the proxies fetch any URL.
  - Tradeoff: the site is down when pc is down. Cloudflare still caches static files and thumbs at the edge.
  - Status: `telecast.company` points at the tunnel, and the fence condition passes. Three conditions fail. "At most 20% ... failed." holds
    YouTube's 6 Nov block until about 08:00 UTC 7 Nov. "10 people used telecast yesterday (UTC)." counts 7 Nov first, on 8 Nov. "pc serves
    origin/main." waits for the push.
  1. When only "pc serves origin/main." fails, Taylor runs `jj push`. The Tier 1 rule needs a passing status, and the push itself fixes that
     condition.
  2. Done when snitch logs telecast as passing: `psql snitch -c "select * from latest where project = 'telecast'"`.
  3. Delete `~/.neon-service` on pc.
  4. Taylor deletes the GitHub secret `DATABASE_URL`, the Pages project, the R2 buckets `rss`, `rss-dev`, `thumb`, `thumb-dev`, and the Neon
     project, and closes the Neon account. Pages also serves `telecast.horse`, so its deletion drops that domain.
  5. Taylor deletes the Mac clone `~/Developer/telecast`. pc holds the commits, `todo.md`, and both dumps.
- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
