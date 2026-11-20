- [ ] The GitHub seed source reads a licensed dataset.
  - `chen-zhitao/Youtube-Channels-Dataset` has no license. Seed reads only its channel IDs, which are facts, and stores no descriptions.
  - Ruled out (2026-11-20): `PleIAs/YouTube-Commons` (CC-BY 4.0, but transcript parquet, over seed's cap); Common Pile `youtube_filtered`
    (its 2,000 curated channels live in a SQLite DB, not a published file); `jwywoo/Korean-Youtuber-Channel-ID-Handles` (MIT, Korean only).
  1. Search again for a channel-ID dataset under an open license (CC0, CC-BY, ODbL), and swap `GITHUB_URL` when one turns up.
- [ ] The pre-commit suite passes on pc under load.
  - Fact (2026-11-20): at load average 30, the suite failed 2 runs of 4. One log was lost. In the other, `budget.test.ts` "16 parallel 30 MB
    feeds staggered 5 ms apart" saw requests 8 and 9 answer 503, but the test expects only the youngest to.
  - Fact (2026-11-20): at load average 30 to 54, "a request past the memory budget gets a 503 Busy and one busy: line each" also failed
    once, in a 31 s run.
  - Cause to confirm: under load, the server does not see the requests in the order they leave 5 ms apart.
  1. Run `budget.test.ts` alongside a CPU burner, e.g. `stress-ng --cpu 32`, and check that both tests fail.
  2. Order the arrivals by the upstream hit order, not by send time: send request i+1 only after the upstream logs hit i.

## Blocked on you

- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
