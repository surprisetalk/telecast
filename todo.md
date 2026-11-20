- [ ] Seed resolves YouTube links outside YouTube's nightly block.
  - Cause: `telecast-seed.timer` fires Mondays at 05:00 UTC, inside the block from about 23:00 to 07:00 UTC, so YouTube answers its resolves
    with 404 or 500.
  - Decision: :30, not :00. snitch runs the status check at :00, and `lastRunAgeS` in `scripts/status.ts` throws while a run is in progress.
  1. In `/etc/nixos/flake.nix`, move the seed timer to `Mon *-*-* 09:30:00 UTC` and the curate timer to `*-*-* 06:30:00 UTC`. Update both
     lines in `readme.md`.
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
- [ ] The pre-commit suite passes on pc under load.
  - Fact (2026-11-20): at load average 30, the suite failed 2 runs of 4. One log was lost. In the other, `budget.test.ts` "16 parallel 30 MB
    feeds staggered 5 ms apart" saw requests 8 and 9 answer 503, but the test expects only the youngest to.
  - Cause to confirm: under load, the server does not see the requests in the order they leave 5 ms apart.
  1. Write a test that runs the case under `nice` alongside a CPU burner, and check that it fails.
  2. Order the arrivals by the upstream hit order, not by send time: send request i+1 only after the upstream logs hit i.

## Blocked on you

- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
