# Cloud, live: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fast cloud playback over two kept-open FTP lanes, an online/offline switch, a ⋮ menu per song, and two new
pages (Download to cloud, Download from cloud).

**Architecture:** `connections.mjs` owns the listen and transfer FTP sessions; `withCloud` borrows one. The stream route
serves a song from its growing `.part` file. Song edits go through new PATCH/DELETE routes on the library and cloud
modules; the two pages reuse the downloader job and a new save job.

**Tech Stack:** Node 26 (`node:test`, `node:sqlite`), basic-ftp, ftp-srv (tests), ffmpeg, Angular 22 (signals), vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-cloud-live-design.md`

## Global Constraints
- No commits and no merge until Tyler says so. Work stays uncommitted on `cloud-extras`.
- FTP password never logged, never sent to the page.
- Lane idle times: listen 15 min, transfer 2 min; keepalive NOOP every 60 s; stale check after 90 s with a 3 s limit.
- Offline error text: "Cloud: the cloud is offline on this laptop. Turn it on in Settings."
- Backend tests: `cd backend && npm test`. Frontend: `cd frontend && npx ng test --watch=false`. Browser check: `node backend/tests/ui-cloud.mjs`.

## Review Focus
- The server drops an idle connection: the next click must reconnect, not fail.
- A Range request starting beyond what is downloaded: must wait, then send the right bytes.
- The client stops listening mid-download (skips the song): the download must go on (it becomes the cached copy), no crash.
- Renaming to a name another file already has: never overwrite (first free name).
- Download to cloud: a failed upload must never delete the laptop copy.

---

### Task 1: Lanes, and the traffic counter removed
**Files:** Create `backend/modules/cloud/connections.mjs`; modify `remote.mjs` (drop `bytes`, add `ping`, `size`, `lastOk`, download `onBytes`), `store.mjs` (`withCloud` borrows a lane, no usage.json, `cloudStatus` without traffic), `limits.mjs` (drop `monthKey`, `usedBytes`, `month`), `upload.mjs` (transfer lane), `settings.mjs` (saving closes lanes); `tests/ftp-fixture.mjs` (`logins`, `dropConnections()`, close lanes); tests `cloud-connections.test.mjs`, update `cloud-store`, `cloud-limits`, `cloud-cache`, `cloud-routes`. Frontend `usage-bar.ts`, `cloud.service.ts` (no `month`/`usedBytes`).
**Interfaces (produces):** `borrow(lane, settings) -> Promise<session>`, `release(lane)`, `openLanes() -> string[]`, `closeLanes() -> Promise`, `setTimings(partial)`; `withCloud(fn, settings?, { lane = 'listen' })`.
- [ ] Tests (RED): `two calls share one connection` (fixture `logins` stays 1 across two `withCloud`); `upload uses its own lane` (`openLanes()` contains 'transfer' during/after an upload, listen still usable); `an idle lane closes` (setTimings idle 50 ms → `openLanes()` empty after 150 ms); `a dropped connection reconnects` (`dropConnections()` then `withCloud(c=>c.index())` resolves); `withCloud never writes usage.json`; limits: `usageSummary` has no `usedBytes`/`month`.
- [ ] Implement; update old tests that read usage.json / monthKey.
- [ ] Backend suite green.

### Task 2: Online / offline
**Files:** `settings.mjs` (`online` default true, saved as boolean; `isOnline(s)`), `store.mjs` (offline refusal before connecting; `cloudStatus` → `{configured, online:false}`), `routes.mjs` (`/songs` offline answer, share 400), `playlistSync.mjs` (skip), `musicDownloader/routes.mjs` (400); tests `cloud-offline.test.mjs`. Frontend: `cloud.service.ts` (`online` in settings/status), `settings.html/ts` switch, `home.html/ts` tile hints, `cloud-page.ts`/`cloud-upload-page` notice, `playlist-page.ts` switch disabled.
- [ ] Tests (RED): offline `withCloud` rejects with the offline text and fixture `logins` stays 0; `/status` → `online:false`; `/songs` → last list + `offline:true, mode:'offline'`; `syncPlaylists` → `{skipped:true}` with 0 logins; share → 400.
- [ ] Implement backend + frontend. Suites green.

### Task 3: Play while downloading
**Files:** `core/http.mjs` (`parseRange`, `streamGrowing(req, res, source, headers)`), `cloud/cache.mjs` (`startFetch(song, settings) -> Download`, writes through a counting Writable, `size` via FTP SIZE), `cloud/routes.mjs` (stream uses it), `tests/ftp-fixture.mjs` (`slow` option: files matching a pattern are sent in delayed chunks). Tests `http-growing.test.mjs`, `cloud-routes` additions.
**Interfaces:** `Download = { id, path (part), target, size, written, done, error, ready: Promise, promise: Promise<path>, changed(): Promise }`; `streamGrowing` uses `source.path/size/written/done/error/changed()/target`.
- [ ] Tests (RED): growing source unit — headers and first bytes arrive before `done`; a Range past `written` waits then returns exact bytes; error mid-way ends the response. Route — a slow cloud song's first byte arrives well before the download ends (< 40 % of total time) and the body is byte-exact; a client that disconnects mid-download still leaves a cached file.
- [ ] Implement. Suites green.

### Task 4: Library song edits (backend)
**Files:** `core/tags.mjs` (`writeTags(path, {title, artist, album, genre})` via ffmpeg `-c copy`), `core/library.mjs` (`genre` column read from tags and listed; `editTrack(id, {title, artist, genre})` → tags, rename to free "Artist - Title.ext", same row; `deleteTrack(id)` → Recycle Bin + forget), `musicPlayer/playlists.mjs` (`renameSongEverywhere(old, next)`), `musicPlayer/routes.mjs` (PATCH/DELETE `/api/library/:id`), `musicDownloader/engine.mjs` (`tagFile` uses `writeTags`). Tests `library-edit.test.mjs` (uses `mp3-fixture`; `FFMPEG_BIN` from config; skip tests when ffmpeg is missing).
- [ ] Tests (RED): edit writes title/artist/genre into the file (read back with music-metadata), renames the file, keeps id and addedAt; a name clash gets " (2)"; playlist entry follows the rename; delete removes the file from the folder and the list (Recycle Bin call stubbed by env `MUSEHIK_TRASH=rm` in tests).
- [ ] Implement. Suite green.

### Task 5: Cloud song edits (backend)
**Files:** `store.mjs` (`renameSong(id, {title, artist, genre})` with FTP rename to a free name), `routes.mjs` (PATCH `/api/cloud/songs/:id`), playlists follow the rename. Tests in `cloud-edit.test.mjs`.
- [ ] Tests (RED): title/artist change renames the cloud file and the list entry (same id); genre-only change leaves the file name; clash → " (2)"; offline → refused.
- [ ] Implement. Suite green.

### Task 6: ⋮ menu and genre filter (frontend)
**Files:** `library-list` (⋮ button per row, `changed` output), new `song-menu/song-menu.ts` (dialog), `arrange.ts` (+`genre` filter, `genresOf`), `core/api.ts` (Track `genre`), `tracks-page`, `cloud-page`, `playlist-page` reload on `changed`; `library.service` (`edit`, `remove`), `cloud.service` (`editSong`, `save`). Specs: `arrange.spec.ts` genre cases.
- [ ] Spec (RED): `arrange` filters by genre, `genresOf` lists distinct sorted genres.
- [ ] Implement dialog + wiring. `ng test` green, `ng build` clean.

### Task 7: Download to cloud (backend)
**Files:** `musicDownloader/jobs.mjs` (`startJob(url, { cloudOnly })`: cloud twins skipped before downloading using the cloud list read at job start; at the end, `queueUpload({ paths, trackIds, removeAfter: paths })`), `cloud/upload.mjs` (`removeAfter`: delete the local file and forget it after it is uploaded or found already on the cloud; never after a failure), `musicDownloader/routes.mjs` (`cloudOnly` replaces `toCloud`; offline/not set up → 400). Tests `download-cloud.test.mjs` updated, `cloud-upload` addition.
- [ ] Tests (RED): upload with `removeAfter` deletes the uploaded file and keeps a failed one; `cloudSelection` carries `removeAfter` = the job's new files only; route 400 when offline.
- [ ] Implement. Suite green.

### Task 8: Download to cloud page (frontend)
**Files:** `nav.service.ts` (`download-cloud`), `home.html` tile, `app.html` route, `link-input` gets `cloudOnly` input (tick box removed), page title "Download to cloud".
- [ ] Implement; `ng test`, `ng build` green.

### Task 9: Save from cloud (backend)
**Files:** new `cloud/save.mjs` (`startSave(ids)`, `getSave`, `activeSave`, `cancelSave`; transfer lane; cache first; writes tags incl. genre; free name in the music folder; `addFile`), `routes.mjs` (POST `/api/cloud/save {ids}`, GET `/api/cloud/save/active`, GET `/api/cloud/save/:id`, POST `/api/cloud/save/:id/cancel`). Tests `cloud-save.test.mjs`.
- [ ] Tests (RED): saves a cloud song into the music folder and library with its list title/artist; uses the cache without a connection when cached; a song already in the library is skipped; Stop leaves no half file.
- [ ] Implement. Suite green.

### Task 10: Download from cloud page (frontend)
**Files:** `nav.service.ts` (`cloud-save`), `home.html` tile, new `features/cloud/cloud-save-page.ts`, `cloud.service.ts` (save calls); ⋮ "Save to this laptop" starts a save of one song.
- [ ] Implement; `ng test`, `ng build` green.

### Task 11: Browser check and docs
**Files:** `backend/tests/ui-cloud.mjs` (offline switch, ⋮ rename on cloud, download-from-cloud page saves a song), README, OBJECTIVES.
- [ ] `node backend/tests/ui-cloud.mjs` passes; backend + frontend suites green.
