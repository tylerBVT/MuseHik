# Cloud upload and listening (design, 2026-11-21)

## Why
The owner and their mother each run MuseHik on their own laptop. Her LWS hosting (several websites, 25 GB/month
of traffic, the sites use 1-2 GB) gets a `music` folder at its root, outside every website. Songs uploaded there
from one laptop can be listened to from the other, without copying the whole library.

## Goals
- Settings: a Cloud section with FTP host, user, password, folder (`music`), plus limits.
- Home: two new tiles, **Cloud upload** and **Cloud**.
- Cloud upload: pick songs from All tracks, a whole playlist, or any folder on the laptop; their audio files go to
  the cloud folder. Songs already on the cloud are skipped.
- Cloud: lists every cloud song like a playlist and plays it.
- Limits: **10 GB of traffic per calendar month** for MuseHik, **30 GB of music stored** at most. A usage bar
  (percentage of the month used, plus storage) on both cloud pages. A warning at 80 %, a clear message at 100 %.

## Non-goals
- No HTTP access, no PHP, nothing installed on LWS: **FTP only**.
- No accounts: everyone with the FTP login sees, plays and deletes every cloud song (roadmap decision).
- No phone support yet (later: the same files can be served over HTTP or PHP without changing them).

## Anti-goals (a failure even if it works)
- MuseHik damaging her websites: it must never read, write or delete outside the configured folder.
- Going over the monthly budget so her sites suffer.
- The FTP password ending up in git, in the browser, or in a log.

## Constraints and risks
- One FTP login. Advice to the owner: create a dedicated LWS FTP account locked to `/music`, and use that one.
- FTPS (encrypted) by default. If the server only accepts plain FTP, the connection test says so and plain FTP must
  be allowed explicitly in Settings.
- Two laptops write the same index files. No locking on FTP: each write re-reads the file just before writing, so
  the window for a lost update is a second. The folder of songs stays the truth: "Rebuild index" re-adds songs
  that are on the cloud but missing from the index.
- Traffic is counted by the app, not by LWS. Both laptops add to one counter file on the cloud. Someone using
  FileZilla by hand is not counted (fine for two trusted users).

## Approaches considered
1. **Everything over FTP, through each laptop's local MuseHik server** (picked). Nothing to set up on LWS,
   password stays on the laptop, music has no public address.
2. FTP upload + files in a web folder behind a password file, listening over HTTP. Needs the music inside a
   website's folder; rejected (the owner keeps the folder at the root, outside the sites).
3. A PHP script on LWS that streams and enforces the limits server-side. Most robust and phone-ready, but a second
   codebase on her hosting; not needed for two laptops. Possible later.

## Design (as agreed)
### On the cloud (`<folder>` = `music`)
```
music/
  library.json   { version: 1, nextId, songs: [{ id, file, title, artist, album, duration, isrc, key, size,
                   addedBy, addedAt }] }   ~250 bytes per song
  usage.json     { months: { "2026-11": { bytes } } }
  songs/         "Artist - Title.mp3" (same naming as the local library; "(2)" on a clash)
```
No SQL: the index is one small JSON file, loaded whole when the Cloud page opens.

### On each laptop
- Settings in `backend/data/cloud.json` (git-ignored, like the library database). The password is never sent
  back to the browser (`hasPassword: true` instead) and never logged.
- Cache: `<heavyDir>/cloudCache/` (outside the project and OneDrive), 2 GB, least recently played song removed
  first. Files never expire by time: they never change.
- Playing a cloud song: if the same song is in the local library (the duplicate check by ISRC / artist + title +
  length) the local file plays, free. Else the cached copy. Else it is fetched over FTP into the cache, then
  played. Halfway through a song the next one in the queue is fetched in advance.
- Covers: shown when the song is on the laptop (local or cached), a placeholder otherwise (no extra traffic).

### Traffic and storage rules
- Every byte moved by MuseHik over FTP counts: song uploads, song fetches, and the small JSON reads and writes.
- Before a transfer: refused if it would pass the month's limit. Before an upload: refused if storage would pass 30 GB.
- At 100 %: uploads and new fetches stop with "Cloud limit reached for November. It resets on 1 December."
  Songs already on the laptop still play.

### Screens
```
Home:     ... [Create playlist] [Cloud upload] [Cloud] [playlists...]

Cloud upload            [ This month: 3.2 of 10 GB  ████░░░░░░ 32 % ]   Storage: 4.1 of 30 GB
  ( Songs | Playlist | Folder )
  [search]  [x] Artist - Title   ...          (Folder: [Choose folder...] or type a path)
  42 songs, 410 MB  ·  6.8 GB left this month            [Upload]
  progress: 12 / 42 · current song · Stop · then: uploaded / already on the cloud / failed (reason)

Cloud                   [ same usage bar ]
  song list (search, click to play, "on this laptop" for local/cached songs)   [Remove songs]
```
- Folder tab: "Choose folder..." opens the Windows folder picker (run by the local server); all audio files in
  it and its subfolders are listed, ticked by default.

### Settings > Cloud
Host, user, password, folder, monthly limit (GB), storage limit (GB), cache size (GB), "Allow unencrypted FTP",
**Test connection** (connects, creates the folder if missing, reports FTPS or plain).

## Left to the builder
API routes and file layout (a new `backend/modules/cloud/` module, a `features/cloud/` front-end folder), job
mechanics (one upload at a time, Stop), error wording, tests (a local FTP server in tests).
