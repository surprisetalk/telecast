- [ ] The GitHub seed source reads a licensed dataset.
  - `chen-zhitao/Youtube-Channels-Dataset` has no license. Seed reads only its channel IDs, which are facts, and stores no descriptions.
  - Ruled out (2026-11-20): `PleIAs/YouTube-Commons` (CC-BY 4.0, but transcript parquet, over seed's cap); Common Pile `youtube_filtered`
    (its 2,000 curated channels live in a SQLite DB, not a published file); `jwywoo/Korean-Youtuber-Channel-ID-Handles` (MIT, Korean only).
  1. Search again for a channel-ID dataset under an open license (CC0, CC-BY, ODbL), and swap `GITHUB_URL` when one turns up.

## Blocked on you

- [ ] Each lecture is transcribed and searchable.
  - Parked: Taylor decides how whisper.cpp shares pc's GPU with llama.cpp: a nightly window that stops llama.cpp, or CPU only.
  1. Download audio with yt-dlp and run whisper.cpp on pc's GPU. Store text in a `transcript` table with a tsvector. Blocked: a run of days
     on pc's GPU, which llama.cpp also uses.
