# Cloud, live: fast playback, online/offline, song menu, cloud download pages

Date: 2026-11-23. Builds on `cloud-extras` (not merged yet). Approved by Tyler in conversation ("option B is good, with the offline option. Go ahead and code it").

## Why

Mum uses the cloud every day; Tyler's laptop never does. Today a cloud song takes about 3 s to start, every action opens and
closes its own FTP connection, songs can't be renamed/deleted/tagged from the list, and getting songs between the cloud and
a laptop takes detours (download to the laptop, then upload; or play to cache, then nothing).

## Goals

1. **Fast cloud playback**: about 0.5–1 s to start a song that is not on this laptop.
2. **Online / offline mode per laptop**: offline never opens a connection.
3. **⋮ menu on every song** (library and cloud lists): rename (title, artist), genre, delete, plus "Save to this laptop"
   (cloud songs) and "Send to cloud" (library songs). A genre filter in the list menus.
4. **"Download to cloud" page**: a link is downloaded and sent to the cloud without keeping the songs on the laptop.
5. **"Download from cloud" page**: tick cloud songs, they are copied into the music folder.
6. **Traffic counter removed** (`usage.json`, "Moved this month"): her hosting has no traffic limit.

Non-goals: parallel uploads, editing the tags inside files that stay on the cloud (see Genre), FileZilla support while the
app runs (assume it is closed), a cloud on Tyler's laptop.

## Approaches (connections)

| | Connections | Playing during an upload |
|---|---|---|
| A. One connection for everything | 1 | waits behind the song being uploaded |
| **B. One for listening, one for transfers (chosen)** | 1, 2 while transferring | never waits |
| C. One connection, playback interrupts the upload | 1 | upload restarts; complex, wasteful |

Tyler picked B: "Connection 1, streaming: kept open while the app runs, used only for playback. Connection 2, transfers:
one shared lane for uploads and downloads, they wait in a queue, it opens when there is work and closes after a few idle
minutes."

## Design

### 1. Connections ("lanes")
- `modules/cloud/connections.mjs` keeps at most two open FTP sessions: **listen** (playing, song list, playlists,
  rename/delete) and **transfer** (uploads, saving songs to this laptop).
- A lane opens at its first use and is reused by every later call. Idle closing: listen after 15 min without use,
  transfer after 2 min. While open and idle, a NOOP every 60 s keeps the server from dropping it.
- If the server dropped the connection, the next call reconnects (basic-ftp marks it closed). If the lane has been
  silent longer than 90 s (laptop asleep), a NOOP with a 3 s limit checks it first; no answer = reconnect.
- Changing the cloud settings closes the lanes (the next call uses the new ones).
- `withCloud(fn, settings, { lane })` borrows a lane instead of opening a session. Default lane: listen.
  Prefetching the next song uses the listen lane too (my call: a click during a 1–2 s prefetch waits at most that).

### 2. Online / offline
- New setting `online` (default true, so Mum's laptop keeps working). Settings > Cloud gets a switch
  "Use the cloud on this laptop" (Online / Offline).
- Offline: `withCloud` refuses before connecting ("The cloud is offline on this laptop. Turn it on in Settings.");
  playlist sync is skipped; `/status` answers `{ configured, online: false }`; `/songs` answers the last known list with
  `offline: true, mode: 'offline'`; sharing a playlist and the cloud download page answer 400.
- Pages: the Cloud tiles show "Offline"; cloud pages show a notice with a link to Settings; the Shared switch is
  disabled with a hint. Songs already on this laptop (library or cache) still play.

### 3. Play while downloading
- The stream route no longer waits for the whole song. The download writes to `<id>.mp3.part` through a counter of
  bytes already on disk; the response sends bytes as they land (Range requests wait for their bytes).
- The size comes from the FTP `SIZE` command (exact), so the browser gets a correct `Content-Length`/`Content-Range`.
  If `SIZE` fails, the old path (wait for the whole file) is used.
- One download per song, however many requests ask (as today). The finished file becomes the cached copy as today.

### 4. Traffic counter removed
- No more `usage.json` reads/writes, no `usedBytes`, no "Moved this month". The storage bar stays (30 GB cap).
  An old `usage.json` on the cloud is left alone (harmless).

### 5. ⋮ song menu
- A ⋮ button at the right of every row (All tracks, Cloud, playlists). It opens a small dialog: Title, Artist, Genre
  fields with Save; Delete (two clicks); "Save to this laptop" (cloud songs not on this laptop) or "Send to cloud"
  (library songs, online laptops only).
- **Library song, Save**: tags written into the file with ffmpeg (`-c copy`, cover kept), file renamed to
  "Artist - Title.ext" (first free name). Same database row (same id, download date kept).
- **Library song, Delete**: the file goes to the Windows Recycle Bin, the row is removed.
- **Cloud song, Save**: the shared list gets the new title/artist/genre; when title or artist changed, the file on the
  cloud is renamed too (FTP rename, first free name). The cached copy stays valid (cached by id).
- **Cloud song, Delete**: permanent, two clicks ("Click again to delete from the cloud").
- **Genre**: written into the MP3 genre tag for library songs; for cloud songs stored in the shared list, and written into
  the file when the song is saved to a laptop. (Rewriting a file on the cloud would mean downloading and re-uploading it.)
- **Playlists**: renaming a song updates the playlist entries that pointed to it (same identity), so it keeps playing there;
  shared playlists sync the change.
- **Genre filter**: a "Genre" menu next to Sort and Period, listing the genres present (plus "Any genre").

### 6. "Download to cloud" page
- New home tile "Download to cloud" and page, same link box and history as "Download new tracks".
- Before each song is downloaded, the cloud list is checked: a song already on the cloud is skipped ("Already on the cloud").
  A song already in the library is not downloaded again; it is sent from the library (and kept there).
- When the download ends, its new songs are uploaded on the transfer lane; each new file is deleted from the laptop (and
  from the library) right after it is safely on the cloud. A song that fails to upload stays on the laptop and the
  history says so.
- Replaces the "Also send to the cloud" tick box on the normal download page.

### 7. "Download from cloud" page
- New home tile "Download from cloud" and page: the cloud songs not in this laptop's library, with tick boxes, a search box,
  "Select all", and "Save N to this laptop".
- A save job on the transfer lane: per song, the cached copy is used when there is one (no network), else it is downloaded;
  the file is written to the music folder as "Artist - Title.ext" with the list's title/artist/genre in its tags, then added
  to the library. Progress like uploads; Stop works.

## Constraints
- FTP password never logged, committed or sent to the page. Never touch anything outside the cloud folder.
- No commits or merge until Tyler says so ("wait before commiting and merging").
- UI copy plain and short, English, like the existing pages.

## Left to the builder
- Exact layout and styling of the dialog and the new pages (follow existing pages).
- Error wording beyond what is written here.
