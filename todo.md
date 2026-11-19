- [ ] Seed resolves YouTube links outside YouTube's nightly block.
  - Cause: `telecast-seed.timer` fires Mondays at 05:00 UTC, inside the block from about 23:00 to 07:00 UTC, so YouTube answers its resolves
    with 404 or 500.
  1. In `/etc/nixos/flake.nix`, move the timer to `Mon *-*-* 09:00:00 UTC`, and update the seed line in `readme.md`.
- [ ] The 4:30 report shows "Seed succeeded in the past 8 days" at 1.0 on pc.
  - Cause: pc's journal reaches back 2.4 days. `llama-cpp-embed` and `ding` write 91% of its lines (nixos todo.md, "pc's journal holds 30
    days"). `lastSuccessS` in `scripts/status.ts` reads the journal for `telecast-seed.service`, which runs weekly. Seed ran on Monday
    2026-11-16 and exited 0, but the journal no longer holds that run.
  1. In `lastSuccessS`, read `systemctl show UNIT -p Result -p ExecMainExitTimestamp` for `telecast-seed.service`, not the journal. systemd
     keeps the last run for as long as the unit stays loaded. Add a test over a sample of that output.
  2. Keep the journal read for `telecast-curate.service` only if its message ID check catches a failure that `Result` misses. Otherwise
     delete it.
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

## Blocked on you

- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
