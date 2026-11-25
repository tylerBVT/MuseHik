# Phone cloud (full cloud manager on Android) — plan

**Goal:** the Android app does everything the laptops do with the cloud, talking straight to the music API
(https://www.waixera.com/music-api): list + play cloud songs, rename/delete, upload files from the phone, save songs
on the phone for offline play, shared playlists (view, play, create, edit, delete), storage bar, settings.

**Not in it:** "Download to cloud" (needs the laptop's yt-dlp), covers (the API has no cover endpoint), playback
with the screen off and the Android back button (separate native work, next).

**Architecture:** the pages stay; only the data layer changes on the phone (`isPhone`):
- `features/cloud/music-api.ts`: zero-import client for the PHP API (fetch; XHR upload with progress in the
  browser). Tested from `backend/tests/phone-music-api.test.mjs` against the real PHP API (Node strips the types).
- `features/cloud/phone/`: settings (localStorage), the phone library (saved songs index, localStorage), files
  (Capacitor Filesystem + File Transfer, behind a small interface), the upload and save jobs (same shapes as the
  laptop's server jobs, so the pages poll them the same way).
- `CloudService`, `LibraryService`, `PlaylistService` branch to the phone code; `cloudTrack()` URLs come from a
  hook (laptop: local server; phone: the saved file, else `{api}/songs/{id}/file?key=`).
- On the phone, "All tracks" = songs saved on the phone; every playlist is a cloud (shared) playlist.

## Tasks
1. music-api.ts + backend test against PHP (status, songs, edit, delete, file URL, upload, playlists, errors).
2. Phone settings, library index, jobs (upload, save) with fakes; vitest specs.
3. Services branch to the phone code; cloudTrack hook; specs.
4. UI: shown pages/tiles, Settings cloud section on the phone, upload "Files on this phone", save page wording,
   song menu (save to / remove from this phone), playlist page (no share switch on the phone).
5. Verify: backend + frontend tests, ng build, the phone UI in Chrome (dev override) against the local PHP API,
   then the APK on the phone.
