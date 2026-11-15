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

## Current objective (experiment 1): three flows, one UI
Architecture (`tmpBack/`, Node, no dependencies): one **service per platform**, one shared **engine**.
```
services/youtube.mjs   link is already the source (single video)
services/spotify.mjs   metadata from public embed page (~50 tracks max per playlist)
services/deezer.mjs    metadata from api.deezer.com (full playlists, no login)
services/index.mjs     registry + detect(link): picks the service from the pasted link
engine.mjs             YouTube search (scored by title/artist/duration) + yt-dlp MP3 download + ffmpeg tagging
lib.mjs                pure helpers (scoring, filenames)
server.mjs             HTTP: POST /api/download -> job id, GET /api/jobs/:id -> progress
ytdlp_launcher.py      runs yt-dlp with a per-process DNS-over-HTTPS fallback for YouTube names (see below)
e2e.mjs                end-to-end check of all three flows against a running server
```
Add a platform = one new file in `services/` + one line in `services/index.mjs`.

- [x] Angular one-page UI in `tmpFront/` (link box, Download button, popups with live progress, failure count).
- [x] yt-dlp + portable ffmpeg in `tmpBack/.venv` (use `python -m yt_dlp`; the `.exe` launcher is blocked by Windows Application Control).
- [x] Unit tests: `cd tmpBack && node --test lib.test.mjs` (8 pass).
- [x] Live check: Deezer playlist from `musicLinks.txt` resolves to 146 tracks; Spotify public playlist resolves to 50.
- [x] **End-to-end verified (2026-11-15)**: `node e2e.mjs` -> PASS for YouTube video, Spotify track, Deezer track. Files in `downloadedMusic/` are 320 kbps MP3 with title/artist/album/track tags and cover art.
- [x] **YouTube block coexistence**: the owner blocks YouTube PC-wide via the Windows hosts file (self-control rule for Chrome). `ytdlp_launcher.py` overrides name lookup only inside the yt-dlp process (for YouTube-related hostnames, only when the system answer is 0.0.0.0/failed) using DoH (1.1.1.1, then 8.8.8.8). Hosts file and other apps untouched; Chrome stays blocked. Verified with the hosts block active.
- [ ] Verify the page in a real browser with screenshots.
- To run: `cd tmpBack && node server.mjs`, then `cd tmpFront && npm start`, open http://localhost:4200.

## Later objectives
- Spotify links (metadata via embed + YouTube match), then Deezer (public API + YouTube match).
- Playlists (multi-track), progress display, error handling for unavailable videos.
- Tagging + cover art, folder layout like OpenCrate.
- Tauri: bundle yt-dlp/ffmpeg as sidecar binaries (Windows).
- Music player features from README.

## Legal note
Downloading from YouTube may violate its terms of service, and copyrighted music should only be saved with permission. This is a personal-use experiment.
