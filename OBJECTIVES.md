# MuseHik – Objectives & Findings

Living file so context isn't lost. Complements `README.md` (overview + status table).

## Vision and next steps
Source of truth: the whiteboard **"Studio Rap FR — carte des services"**: https://claude.ai/artifact/J1x1VAdYquncSbndiRqqEP
(written in French; translated below on 2026-11-17. If the board changes, update this section.)

**The idea in one sentence:** a song goes in, and its instrumental and your own lyrics come out.

**The path of a song** (each step feeds the next):
1. **Source**: a YouTube, Deezer or Spotify link.
2. **Downloader + Player**: get the audio and play it. *Done.*
3. **Separation**: split the song into vocals and instrumental. *In progress.*
4. **Lyrics**: get the song's lyrics, synchronised line by line with the audio.
5. **Analysis**: find the tempo (BPM), the beats and the bars.
6. **Studio**: karaoke + a writing notebook + a rhyme finder. This is what sets the project apart from any other player.

### Short term: an MVP you actually enjoy using
- **Downloader** (done): fetch the audio from YouTube / Deezer / Spotify (yt-dlp; Spotify and Deezer give metadata only, the audio is matched on YouTube).
- **Player** (partly done): play songs, and switch between the **original and the instrumental only**.
  The board marks this as done, but the original/instrumental switch is **not built yet**; it needs the separator first.
- **Official instrumental**: before using AI, look for a real "(Instrumental)" release of the song on Spotify, Deezer or MusicBrainz. An official instrumental always beats a separated one.
- **AI separation**: when no official instrumental exists, separate the song with Demucs / RoFormer models, producing the instrumental and the vocals as WAV. *Current work (see "Instrumental separator" below).*
- **Lyrics**: download synchronised lyrics (LRC format) from LRCLIB.
- **Karaoke**: scroll the lyrics in time with the music.
- **Local library** (done): SQLite + audio files; everything stays on your own machine.

### Medium term: what makes it unique
- **Lyrics alignment**: when LRCLIB has nothing, use WhisperX on the isolated vocals to find the words and their timing.
- **Music analysis**: BPM, beats, bars and musical key (librosa, Essentia).
- **Writing notebook**: write, tag and organise your own lyrics.
- **French phonetic engine**: turn text into phonemes (espeak-ng, the Lexique 3 database), so rhymes are found from sounds, not spelling.
- **Rhyme finder** (key feature): rhymes, assonances and multisyllabic rhymes, searched across your whole collection of texts.
- **Search by theme** (key feature): find your texts about a subject with embeddings + sqlite-vec. It only filters and finds; it never writes text for you.
- **Training mode** (key feature): your text laid out bar by bar on the instrumental, to practise your placement.

### Long term: the product
- **Voice recording**: rap over the instrumental and export a demo.
- **Flow score**: measure whether your syllables land on the beats.
- **Type-beat catalogue**: search beats and save favourites by BPM and mood.
- **GPU workers**: a job queue (Redis + Celery) to separate many songs at once.
- **Cloud and accounts**: Postgres + object storage, sync across devices.
- **Mobile app**: notebook + karaoke in your pocket.
- **Licences and business**: leases, rights, monetisation. Much later.

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
Stack: **Angular** front end (`frontend/`), **Node** server with no framework (`backend/`), **SQLite** library index (Node built-in `node:sqlite`),
yt-dlp + ffmpeg in `backend/.venv`. Only npm dependency of the server: `music-metadata` (reads tags/covers).

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

### Repository layout (by module: musicDownloader, musicPlayer, instrumentalSeparator)
```
frontend/                       Angular app (one app, one router, one player bar)
  src/app/core/                 api, library.service, nav, theme (shared by every feature)
  src/app/shared/               page-header
  src/app/home/, settings/      home page, settings page
  src/app/features/
    musicDownloader/            link-input, download-page
    musicPlayer/                player-bar, library-list, pages (tracks, playlist, playlist-editor), player/queue/playlist services
    instrumentalSeparator/      separator-page (pick a song + a method, progress, listen/compare/download), separator.service
backend/                        Node server, one package.json; config.json, .venv and data/ live here (git-ignored)
  server.mjs      CORS + asks each module's routes.mjs in turn; scans the library at start
  core/
    config.mjs    config.json loading, music folder, data/, Python + ffmpeg paths. Priority: MUSIC_DIR env > config.json > ../downloadedMusic
    library.mjs   the SQLite database + track index: scan folder, findDuplicate(), list, cover art
    lib.mjs       pure helpers (scoring, trackKey, fileBase)
    http.mjs      readJson()
  modules/        each one exports handle(req, ctx) from routes.mjs
    musicDownloader/
      routes.mjs          POST /api/download, GET /api/jobs/:id, POST /api/jobs/:id/cancel
      jobs.mjs            background jobs: resolve link, skip known songs, 3 downloads in parallel, Stop + cleanup
      services/{youtube,spotify,deezer}.mjs   one file per platform: parse link + read track list. index.mjs = registry/detect()
      engine.mjs          YouTube search (scored by title/artist/duration), yt-dlp MP3 download, ffmpeg tagging
      ytdlp_launcher.py   yt-dlp with a per-process DNS-over-HTTPS fallback (see "YouTube block" below)
      migrate-flat.mjs    one-off: flatten old playlist folders / strip "NN - " prefixes (dry run unless --apply). Already applied.
    musicPlayer/
      routes.mjs          GET /api/library, POST /api/library/rescan, /api/library/:id/stream (HTTP Range), /api/library/:id/cover,
                          GET/POST /api/playlists, GET/PUT/DELETE /api/playlists/:id
      playlists.mjs       playlist tables + CRUD (in the shared database)
    instrumentalSeparator/
      routes.mjs, jobs.mjs    /api/separator/*: methods, jobs (one at a time on the GPU), results (play/download/delete)
      separate.py, methods.json, engine/   Python engine (code copied from the open-source repos, see its NOTICE.md)
  tests/          npm test (= node --test tests/); e2e.mjs (3 platforms), e2e-stop.mjs (Stop button), e2e-playlists.mjs, ui-separator.mjs,
                  demo-ui.mjs <link> (visible Chrome pastes+downloads), ui-check.mjs / ui-pages.mjs (real Chrome), cdp.mjs helper
openSourceProjects/             cloned third-party repos, read-only inspiration (git-ignored)

Outside the project (not synced by OneDrive), C:/Users/tyler/MuseHikData/ = config heavyDir:
  separator-venv/                 Python 3.13 + PyTorch CUDA 12.8 for the separator (RTX 5060 needs cu128)
  models/                         separation model files (downloaded on first use)
  openSourceProjects/instrumentalSeparator/   python-audio-separator, Music-Source-Separation-Training, demucs,
                                  ultimatevocalremovergui, karaoke-gen, sigsep-mus-eval (read-only study)
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

## Instrumental separator (started 2026-11-17)
Goal: the best instrumental possible from any song. Code and docs: `backend/modules/instrumentalSeparator/` (README, NOTICE).

### What the open-source projects do (study, 2026-11-17)
All of them: song -> spectrogram -> an AI model marks what is voice -> back to sound, on overlapping chunks.
The instrumental is either the model's direct output or song - vocals. Best model family today: **RoFormer**
(BS-RoFormer, Mel-Band RoFormer); MDX-Net, Demucs and VR are older.

| Project | What it does | What we took |
|---|---|---|
| python-audio-separator | One library for all model types; downloads models; ready-made ensemble presets | RoFormer model code, model download mirrors, model loading |
| ZFTurbo Music-Source-Separation-Training | The toolkit most top RoFormer models are trained with | Chunked overlap-add inference with fades; test-time augmentation (3 passes) |
| Ultimate Vocal Remover GUI | The popular desktop app | Ensemble methods: Average, Max Spec (fuller), Min Spec (cleaner) |
| karaoke-gen | Karaoke video maker built on audio-separator | Two instrumentals: clean, and with backing vocals added back |
| demucs | Facebook's model; random time-shift averaging | Nothing for now (behind RoFormer on vocals vs instrumental) |
| sigsep-mus-eval (museval) | SDR scoring against a true instrumental | Not used yet: needs songs with an official instrumental |

### The three methods (built, 2026-11-17)
| Method | How | Time, 2:50 song, RTX 5060 Laptop |
|---|---|---|
| Fast | Resurrection Inst, 1 pass | 47 s |
| Best quality | Resurrection + becruily + FV7z, 3 TTA passes each, averaged | 4 min 11 s (was 8 min 41 s with overlap 4; lowered to 2) |
| Keep backing vocals | Resurrection (3 passes); removed voice -> karaoke model -> backing added back | 2 min 25 s |

Checked on Hugo TSR "Des voix résonnent": same length as the original, tags + cover kept, the removed part follows
the voice (falls to silence when he stops). **Not yet judged by ear.**

### Next
- [ ] Listen and compare the three on several songs (owner).
- [ ] Score with an official instrumental (SDR, museval) to tune: which models, Average vs Max/Min Spec, overlap.
- [ ] Player switch original / instrumental (needs a result to exist; results are in the music folder as "<song> (Instrumental).mp3").

## Cloud (built 2026-11-21)
Design: `docs/superpowers/specs/2026-11-21-cloud-design.md`. Module: `backend/modules/cloud/`, pages in `frontend/src/app/features/cloud/`.
- FTP only (no HTTP, nothing installed on LWS). The `music` folder sits at the hosting root, outside every website.
  Cloud layout: `music/library.json` (index), `music/playlists.json`, `music/songs/`.
- Limits: 30 GB stored, warning at 80 %, stop at 100 %. Traffic is not counted any more (2026-11-23: her plan has no
  traffic limit; the 10 GB/month cap and then the counter were removed; an old `music/usage.json` is just ignored).
- Each laptop: settings in `backend/data/cloud.json`, cache of played songs in `MuseHikData/cloudCache` (2 GB, least recently played removed first).
  A cloud song that is also in the local library plays from the local file (free). The next song is fetched at half time.
- Advice: give MuseHik its own LWS FTP account restricted to `/music`, not the main hosting login.
- [ ] Try it against the real LWS hosting (FTPS support, missing-file reply codes, speed).

### Shared playlists (built 2026-11-21)
Design: `docs/superpowers/specs/2026-11-21-shared-playlists-design.md`.
- One kind of playlist with a **Shared** switch. Shared ones live in `music/playlists.json` too; the side changed last
  wins; unsharing or deleting travels as `{ uid, deleted: true }`. Each person edits only their own (not enforced).
- Playlists store songs **by identity** (title, artist, album, length, ISRC), matched when read: library, then
  cloud, else greyed "not available". Fixes the roadmap's "playlists point at library numbers" weakness.
- Sharing uploads the playlist's songs the cloud lacks; later additions upload at the next sync (start, every
  5 min, home page open, 2 s after a change). The editor also lists cloud songs not on this laptop.
- Settings > Cloud > Your name: shown on shared playlists ("from Tyler").

### Cloud extras (built 2026-11-23, after the first real test)
Design: `docs/superpowers/specs/2026-11-23-cloud-extras-design.md`.
- Songs put in `music/songs/` by hand (FileZilla) show up when the Cloud page opens (name "Artist - Title.mp3"; real
  tags filled in at first play); files deleted by hand leave the list. Uploads never overwrite a hand-added file.
- Library and Cloud lists: sort (title, artist, newest, oldest) and filter (7 days, 30 days, 12 months); each row shows
  its date (library: when the file appeared on this laptop; cloud: when it was uploaded).
- Downloader: "Also send to the cloud" uploads the download's songs when it ends (waits if an upload is running).
  Replaced on 2026-11-23 by the "Download to cloud" page (below).

### Cloud, live (built 2026-11-23)
Design: `docs/superpowers/specs/2026-11-23-cloud-live-design.md`. Plan: `docs/superpowers/plans/2026-11-23-cloud-live.md`.
- **Two connections at most**, each with one job (FTP does one thing at a time per connection):
  *listen* (playing, lists, playlists, edits; kept open, closed after 15 min idle) and *transfer* (uploads, saving to
  this laptop; opened when needed, closed after 2 min idle). A keep-alive every minute; a silent connection is checked
  before use and reopened if the server dropped it.
- **Plays while it downloads**: a cloud song starts as soon as its first bytes arrive (like Deezer), and the download
  becomes the cached copy.
- **Online / Offline** per laptop (Settings > Cloud > "Use the cloud on this laptop"). Offline never connects: the
  Cloud page shows the last list it saw, songs already on this laptop still play, cloud tiles say "Offline".
- **⋮ menu on every song** (library and cloud): rename (title, artist: the file is renamed too, playlists follow),
  genre (written in the MP3, a Genre filter on the lists), delete (library: Recycle Bin; cloud: gone for good, two
  clicks), Send to cloud / Save to this laptop.
- **Download to cloud** (home tile): downloads from a link, uploads, then deletes the new files from this laptop.
  Songs the cloud already has are skipped; songs already in the library are sent and stay.
- **Download from cloud** (home tile): tick cloud songs, they are copied into the music folder with the list's title,
  artist and genre (from the cache when already played here; Stop leaves no half file).
- [ ] Try it on her laptop against the real LWS hosting (play-while-downloading speed, idle drops).

## Legal note
Downloading from YouTube may violate its terms of service, and copyrighted music should only be saved with permission. This is a personal-use experiment.
