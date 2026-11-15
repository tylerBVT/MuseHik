# MuseHik – Objectives & Findings

Living file so context isn't lost. Complements `README.md` (music player architecture).

## Decisions so far
- Stack direction: Angular + Tauri 2 (Windows + Android). Windows only on desktop.
- The music **player** (see README) and the **downloader** (link -> audio file) are two sides of the project.
- Downloader is a Windows/PC-side feature (needs yt-dlp + ffmpeg, which can't realistically run on Android).
- Downloaded audio must end up in `downloadedMusic/`.

## Inspiration repos (in this folder, for reading only)
| Folder | Language | Platforms | Size | Notes |
|---|---|---|---|---|
| `OpenCrate` | Node (no deps) + yt-dlp + ffmpeg + Python/mutagen for tags | Spotify + YouTube | ~284 lines of JS | Simplest. Chosen as the model. |
| `harmony` | Python (FastAPI) + spotDL | Spotify + YouTube Music | ~15k lines | Full library manager, Docker, DB. Too big. |
| `songmirror` | Python + spotDL | Deezer (+ many others) | ~32k lines | Playlist sync between services. Too big. |

## How they actually download (key finding)
**None of them downloads audio from Spotify or Deezer.** Those services are DRM-protected. The pattern is always:
1. **Read metadata** from the link (title, artist, album, duration, cover). Spotify: public embed page (`open.spotify.com/embed/...`, JSON in `__NEXT_DATA__`) or Web API token. Deezer: public API (`api.deezer.com`) – no login needed for public playlists.
2. **Find a matching audio source** on YouTube (or SoundCloud) by searching "artist - title", ranking by title/artist/duration (`yt-dlp ytsearch5:...`). spotDL does the same thing.
3. **Download with yt-dlp**: `-x --audio-format mp3 --audio-quality 320K`, plus thumbnail + info.json. ffmpeg converts the audio.
4. **Tag the file** (title, artist, album, track no., cover art) with Mutagen/ffmpeg.
5. **Organize**: `Playlists/<name>/NN - Artist - Title.mp3`, `cover.jpg`, `playlist.m3u8`, `manifest.json`.

YouTube links are the easy case: step 2 isn't needed, the link already is the source.
Caveat: audio quality is that of YouTube (lossy), and matches can pick the wrong recording.

## Status (2026-11-15): downloader + library + player, all working
Stack: **Angular** front end (`tmpFront/`), **Node** server with no framework (`tmpBack/`), **SQLite** library index (Node built-in `node:sqlite`),
yt-dlp + ffmpeg in `tmpBack/.venv`. Only npm dependency of the server: `music-metadata` (reads tags/covers).

### What was borrowed from the three reference apps
| Idea | From |
|---|---|
| SQLite library index is the source of truth; the folder is only reconciled into it | Harmony (ADR 0001) |
| Flat `Artist - Title.ext` files, playlists = membership data, not folders | Harmony |
| Duplicate check by ISRC, then normalised key (+ duration); version words (remix, live...) keep songs apart; never auto-delete | Harmony + SongMirror |
| Skip files that exist, resumable runs, per-track failure reasons, editable retry (retry still TODO) | SongMirror / OpenCrate |
| Cover art embedded in every file | OpenCrate |
| Spotify = metadata only, audio matched on YouTube | OpenCrate / spotDL |
None of the three has a player (Harmony delegates to Navidrome, SongMirror to Jellyfin); the player is our own.

### Layout of `tmpBack/`
```
services/{youtube,spotify,deezer}.mjs   one file per platform: parse link + read track list. index.mjs = registry/detect()
engine.mjs      YouTube search (scored by title/artist/duration), yt-dlp MP3 download, ffmpeg tagging, config.json loading
library.mjs     SQLite index: scan folder, findDuplicate(), list, cover art
lib.mjs         pure helpers (scoring, trackKey, fileBase)
server.mjs      jobs (POST /api/download, GET /api/jobs/:id, POST /api/jobs/:id/cancel) + library (GET /api/library,
                /api/library/:id/stream with HTTP Range, /api/library/:id/cover, POST /api/library/rescan)
ytdlp_launcher.py   yt-dlp with a per-process DNS-over-HTTPS fallback (see "YouTube block" below)
config.json     musicDir (git-ignored; template config.example.json). Priority: MUSIC_DIR env > config.json > ../downloadedMusic
migrate-flat.mjs   one-off: flatten old playlist folders / strip "NN - " prefixes (dry run unless --apply). Already applied.
tests           node --test lib.test.mjs (12 unit tests); e2e.mjs (3 platforms), e2e-stop.mjs (Stop button), e2e-playlists.mjs,
                demo-ui.mjs <link> (visible Chrome pastes+downloads), ui-check.mjs (13 player checks in real Chrome), cdp.mjs helper
```
### Done and verified
- [x] Download from YouTube (video + playlist), Spotify (track/album/playlist, embed limit ~50-100), Deezer (full playlists). Link platform is auto-detected.
- [x] Playlist progress bar, 3 downloads in parallel, each file lands as soon as done, Stop keeps finished tracks and removes half-finished ones.
- [x] Flat library folder `C:/Users/tyler/Documents/downloadedMusic` (outside OneDrive; 107 songs after migration). Folder contains only audio.
- [x] Before any search/download the library is checked; known songs are skipped. UI: expandable "already on your device" and "could not be downloaded" lists with the reason.
- [x] Player: song list with covers + text search, play/pause, previous (restarts if >3 s in) / next, seek, volume, now-playing bar, MediaSession (media keys). `node ui-check.mjs` = 13/13 pass in Chrome.
- [x] YouTube block: the owner blocks YouTube PC-wide in the Windows hosts file (self-control for Chrome). `ytdlp_launcher.py` asks DoH (1.1.1.1, then 8.8.8.8) only inside the yt-dlp process, only for YouTube names and only when the system answer is 0.0.0.0/failed. Hosts file and Chrome untouched.

### Listening experience (spec written, waiting for review)
Full spec with per-requirement test status: `docs/PLAYER_SPEC.md` (Listen home page, auto-next, Deezer-style mini player,
full-screen player, shuffle, repeat, remembered settings, automated test plan, manual test sheet).

### Next ideas (not started)
- [ ] "Retry failed" button (+ editable source URL like OpenCrate); persist job history.
- [ ] Format option: keep YouTube's AAC/Opus (`.m4a`, ~3x smaller, no re-encode) instead of MP3 320k. Format is the only open decision from the design talk; MP3 kept for now.
- [ ] Playlists as data in the library (membership by track id) + `.m3u8` export; then queue/shuffle/repeat in the player.
- [ ] Spotify full playlists (embed caps at ~50-100; needs a token like OpenCrate/Harmony).
- [ ] Spotify "Dance Party" and YouTube "Teen Party Music" playlist runs (only Deezer "phil harmonie" was tested end to end).
- [ ] Tauri shell (Windows) with yt-dlp/ffmpeg as sidecars; Android build with native background playback (see README).

## Legal note
Downloading from YouTube may violate its terms of service, and copyrighted music should only be saved with permission. This is a personal-use experiment.
