# MuseHik — technical explanation

A complete description of MuseHik's architecture, tech stack and third-party code, written so that a person or an AI
assistant can understand the whole project from this one file. For a user-level introduction, see `README.md`.

Version described: **v1.0.4** (2026-11-26).

---

## 1. Summary

MuseHik is a personal music app (two users, one developer). It is a **monorepo with five deployable parts**:

| Part | Folder | Language / framework | Runs where |
|---|---|---|---|
| User interface | `frontend/` | TypeScript, **Angular 22** (standalone components, signals) | In the Electron window, a browser, or the Android app |
| Local server | `backend/` | **Node.js 24** (plain `node:http`, ES modules `.mjs`, no framework) + **Python** child processes | On each Windows laptop |
| Windows app | `desktop/` | **Electron 45**, electron-builder (NSIS), electron-updater | Windows 10/11 x64 |
| Cloud API | `music-api/` | **PHP 8.1+** (plain PHP, no Composer, no database) | Shared PHP web hosting (LWS, Apache) |
| Android app | `frontend/android/` | **Capacitor 8** + native **Java** (AndroidX Media3) | Android 7+ (minSdk 24, targetSdk 36) |

What it does: downloads music from links (YouTube / Spotify / Deezer → YouTube audio via **yt-dlp** → MP3 via
**ffmpeg**), keeps a **SQLite** library index, plays music with a queue/shuffle/repeat player, syncs songs and shared
playlists through a self-hosted PHP cloud API, and creates instrumentals with GPU **PyTorch** source-separation models
(**BS-RoFormer / Mel-Band RoFormer**).

---

## 2. Architecture

```text
                    ┌───────────────────────── Windows laptop ─────────────────────────┐
                    │                                                                   │
 User ──► Electron window (desktop/main.mjs)                                            │
                    │   loads http://127.0.0.1:<port>                                    │
                    ▼                                                                   │
            Angular app (frontend/dist, served as static files by the backend)          │
                    │  fetch('/api/...')  (JSON, polling for job progress)              │
                    ▼                                                                   │
            Node backend (backend/server.mjs, node:http)                                │
             ├─ core/library.mjs ── SQLite (node:sqlite) library.db                     │
             ├─ modules/musicDownloader ── spawns Python: yt-dlp ── ffmpeg ──► MP3 files │
             │        └─ Spotify embed page / Deezer public API (track lists)           │
             ├─ modules/musicPlayer ── audio streaming (HTTP Range), covers, playlists   │
             ├─ modules/instrumentalSeparator ── spawns separate.py (PyTorch CUDA, GPU)  │
             ├─ modules/cloud ── HTTPS client of the music API, local LRU cache          │
             └─ modules/app ── settings, music folder, profile                          │
                    │                                                                   │
                    └──────────── HTTPS + X-API-Key ───────────┐                        │
                                                               ▼                        │
                                          PHP music API (music-api/index.php)           │
                                          on shared hosting: songs/ + library.json +    │
                                          playlists.json (file-locked JSON, no DB)      │
                                                               ▲                        │
 Android phone: same Angular build in Capacitor ── HTTPS ──────┘                        │
   native Media3 player (MusicService.java) for background playback                     │
```

Key design choices:
- **The backend is the only thing that touches the disk, Python and the network for the laptop UI.** The Angular app
  only calls `/api/*` on the same origin.
- **Each backend module exposes `handle(req, ctx)` in its `routes.mjs`**; `server.mjs` asks each module in turn. Anything
  not under `/api/` is served from the built Angular app (`core/static.mjs`).
- **Long work runs as background jobs** (download, separation, cloud upload/save), one at a time per kind, with
  progress read by the UI through polling, and a Stop button that kills the whole process tree (`taskkill /T`).
- **The phone has no server.** `frontend/src/app/core/platform.ts` (`isPhone`, `hasServer`) hides the downloader,
  separator and server-backed pages; the phone's cloud code (`features/cloud/phone/`) talks to the music API directly.

---

## 3. Tech stack, by layer

### 3.1 Frontend (`frontend/`)

| Technology | Version | Use |
|---|---|---|
| Angular (`@angular/core`, `common`, `forms`, `platform-browser`, `compiler`, `router` installed) | ^22.2 | UI framework: standalone components, **signals** (`signal`, `computed`, `effect`) for state |
| `@angular/build` (esbuild-based `application` builder), `@angular/cli` | ^22.2 | Build and dev server (`ng serve`, port 4200) |
| TypeScript | ~6.0 | Language |
| RxJS | ~7.8 | Present as an Angular dependency |
| Vitest (via `@angular/build:unit-test`) + jsdom | ^5 / ^30 | Unit tests (`*.spec.ts`) |
| Prettier | ^3.8 | Formatting |
| `music-metadata` | ^12.8 | Reads tags of audio files on the phone |
| Capacitor (`core`, `android`, `app`, `filesystem`, `file-transfer`, `cli`) | ^8.6 | Android packaging, files, downloads, back button |
| Web APIs | — | `fetch`, `<audio>`, **Media Session API** (media keys, OS controls), `localStorage`, History API |

Notable implementation details:
- **No Angular router in use for navigation**: the current page is a signal (`core/nav.service.ts`) and each move is
  pushed into browser history so the Back button works.
- Features are split by folder: `features/musicDownloader`, `features/musicPlayer` (library list, player bar, queue,
  playlists, song menu), `features/instrumentalSeparator`, `features/cloud` (+ `phone/`), `settings/`, `home/`.
- `features/musicPlayer/queue.ts` holds pure, unit-tested "what plays next" rules (shuffle as a permutation array,
  repeat off/all/one).
- `core/native-audio.ts`: on Android, a Capacitor plugin (`NativePlayerPlugin`) dresses Android's native player as the
  `<audio>` element the `PlayerService` drives, and hands it the full play order.
- `core/desktop.ts` talks to Electron through the preload bridge (`check-updates`, `update-state`, `update-ready`,
  `restart-to-update`, `pick-folder`).
- Theme in plain CSS custom properties (`theme.css`, `theme.service.ts`).

### 3.2 Backend (`backend/`)

| Technology | Version | Use |
|---|---|---|
| Node.js | 24 LTS | Runtime; plain `node:http` server, ES modules, `fetch`, `AbortSignal` |
| **`node:sqlite`** (`DatabaseSync`) | built into Node | The library index and playlists (`library.db`); no external DB dependency |
| `node:test` | built into Node | Test runner (`npm test` → `node --test tests/*.test.mjs`) |
| `music-metadata` | ^12.5 | Reads tags, duration and covers of audio files when scanning the library |
| Python | 3.13+ (dev venv `backend/.venv`; 3.14 bundled in the installer) | Runs yt-dlp |
| **yt-dlp** (`yt-dlp[default]`, includes **yt-dlp-ejs**) | ≥ 2026.10.26, auto-updated | Searches and downloads audio from YouTube; ejs solves YouTube's JS challenges using Node |
| **imageio-ffmpeg** | 0.8.1 | Provides an `ffmpeg` binary (MP3 encoding, tag writing without re-encoding) |
| Chrome DevTools Protocol (own small client, `tests/cdp.mjs`) | — | Browser UI checks (`tests/ui-*.mjs`, `tests/e2e*.mjs`) |
| PHP (local, for tests) | 8.1+ | Runs the music API with PHP's built-in server in tests |

Backend modules (`backend/modules/*/routes.mjs`):

| Module | Responsibility |
|---|---|
| `app` | App settings, music folder choice (`core/pickFolder.mjs`), user profile |
| `musicDownloader` | Link → services (`services/youtube.mjs`, `spotify.mjs`, `deezer.mjs`) → match on YouTube (`core/lib.mjs rankMatches`) → yt-dlp download → ffmpeg MP3 + tags → library. Job queue with pause/resume on YouTube "not a bot" blocks (back-off 10/20/40/60 min), retry with an updated yt-dlp, error explanations (`errors.mjs`), download reports. `updater.mjs` keeps yt-dlp up to date (daily, on failure, stable → nightly fallback, rollback). `ytdlp_launcher.py` adds an in-process DNS-over-HTTPS fallback (Cloudflare 1.1.1.1, Google 8.8.8.8) for YouTube hostnames only. |
| `musicPlayer` | Library list, audio streaming with HTTP Range, cover art, playlists (`playlists.mjs`, songs stored by stable identity) |
| `instrumentalSeparator` | API + one-at-a-time GPU job queue (`jobs.mjs`) that runs `separate.py` and reads JSON progress lines |
| `cloud` | Client of the music API (`api.mjs`), uploads (`upload.mjs`), saving cloud songs locally (`save.mjs`), playback cache (`cache.mjs`, 2 GB LRU), storage limits (30 GB), shared-playlist sync (`playlistSync.mjs`, "last change wins" with tombstones), settings and Online/Offline switch |

Core (`backend/core/`): `config.mjs` (paths, env vars), `library.mjs` (SQLite schema, folder scan reconciled into the
index, duplicate detection), `lib.mjs` (song identity keys: ISRC → source id → normalised artist+title+duration),
`tags.mjs` (ffmpeg tag writing, delete to Recycle Bin), `http.mjs`, `static.mjs`.

Environment variables: `PORT` (default 3000), `MUSEHIK_DATA_DIR`, `MUSEHIK_HEAVY_DIR` (default
`%USERPROFILE%\MuseHikData`, outside OneDrive), `MUSEHIK_DEFAULT_MUSIC_DIR`, `MUSEHIK_INSTALLED`, `MUSEHIK_PHP`,
`LIBRARY_DB`.

### 3.3 Instrumental separator (AI, `backend/modules/instrumentalSeparator/`)

| Technology | Version | Use |
|---|---|---|
| **PyTorch** + torchaudio | CUDA 12.8 build (`cu128`, required for RTX 50xx) | GPU inference |
| Python | 3.13 (own venv: `MuseHikData\separator-venv`) | Separate from the downloader's Python |
| `rotary-embedding-torch` | ≥0.6.1,<0.7 (pinned: 0.9 silently breaks separation) | RoFormer rotary position embeddings |
| `beartype` | ≥0.18.5,<0.19 | Runtime type checks used by the RoFormer code |
| `einops`, `numpy`, `pyyaml`, `packaging` | — | Tensor reshaping, arrays, model configs |
| ffmpeg | — | Decode to 44.1 kHz stereo float, encode MP3 320k with the original tags and cover |

Models (community checkpoints + YAML configs, downloaded on first use to `MuseHikData\models\`, 200–900 MB each):
**BS-RoFormer "Resurrection Inst"** (unwa), **Mel-Band RoFormer Instrumental** (becruily), **Mel-Band RoFormer
Instrumental FV7z** (Gabox), **Mel-Band RoFormer Karaoke** (aufr33 & viperx).

Methods (`methods.json`, read by both Python and the UI):
- **Fast**: Resurrection Inst, 1 pass (~47 s for a 2:50 song on an RTX 5060 Laptop).
- **Best quality**: 3 models × 3 passes (normal / L-R swapped / polarity flipped = MSST test-time augmentation),
  averaged with UVR's Average ensemble (~4 min).
- **Keep backing vocals**: clean instrumental, then the removed voice goes through the karaoke model to split lead from
  backing, and the backing is mixed back in (karaoke-gen's method, ~2.5 min).

Pipeline: chunked inference with overlap and cross-fades (`engine/inference.py`) → TTA → ensemble (`engine/ensemble.py`)
→ MP3. **librosa is deliberately not used**: Windows Smart App Control blocks its `numba` dependency, so the one needed
function (mel filter bank) is copied into `engine/roformer/mel_filters.py`.

### 3.4 Windows app (`desktop/`)

| Technology | Version | Use |
|---|---|---|
| **Electron** | ^45.4 | App window; starts the backend as a child process with its own bundled Node; single-instance lock; IPC via `preload.cjs` |
| **electron-builder** | ^26.18 | Builds an **NSIS** one-click, per-user installer (`MuseHik-Setup-<version>.exe`, x64) |
| **electron-updater** | ^6.8 | Auto-updates from **GitHub Releases** (checked at start and every 4 h, installed on "Restart now" or quit) |
| Bundled Node | 24.22.3 (win-x64 zip, SHA-256 checked) | Runs the backend and yt-dlp-ejs |
| Bundled Python | **python.org 3.14.10 from the NuGet `python` package** (SHA-512 checked) | Signed by the PSF, so Windows Smart App Control accepts its DLLs (an unsigned python-build-standalone build was blocked). Copied on first start to `%LOCALAPPDATA%\MuseHik\python` so yt-dlp can update itself. |

`scripts/stage.mjs` gathers `stage/node`, `stage/python` (with `backend/requirements.txt` installed),
`stage/backend` (+ production `node_modules`) and `stage/web` (built Angular app) into the installer's
`extraResources`. `scripts/smoke.mjs` starts the built app's backend with its own Node and Python before publishing.
`scripts/release.mjs` runs tests, bumps the version, creates an annotated tag and pushes it.

Installed-app data: `%APPDATA%\MuseHik\` (settings, `library.db`), `%LOCALAPPDATA%\MuseHik\` (Python copy, cloud
cache, `logs\server.log`), songs in `Music\MuseHik\` by default.

### 3.5 Cloud API (`music-api/`)

| Technology | Use |
|---|---|
| **PHP 8.1+** (hosting runs 8.5), extensions `json`, `mbstring`, `intl` (optional) | REST API, no framework, no Composer |
| Apache `.htaccess` | Routes every request to `index.php`; denies `config.php`, `lib/` and dot files |
| JSON files with file locks (`lib/store.php`) | `library.json`, `playlists.json` — no database |
| Plain files | Audio in `music/songs/` (the data folder is denied to the web by its own `.htaccess`) |
| `router.php` | Same routing for PHP's built-in server (local dev/tests) |

API: auth by `X-API-Key` header or `?key=` (for `<audio>` elements); CORS for the Capacitor phone app;
`Cache-Control: private, no-store`. Endpoints: `GET /status`; `GET/POST /songs`; `GET|HEAD /songs/{id}/file` with
byte ranges (`206`/`416`); `PATCH|DELETE /songs/{id}`; `GET /playlists` (`?raw=1` for sync with tombstones);
`PUT /playlists/{uid}` (last-write-wins under lock); `POST /playlists`; `PATCH|DELETE /playlists/{id}`. Songs dropped
into `songs/` by hand (e.g. with FileZilla) are picked up automatically.

Deployment: `music-api/deploy.mjs` uploads over **FTP with TLS (FTPS via curl)**, atomic temp-name-then-rename uploads,
writes `config.php` (API key) only on first deploy, then runs live security and behaviour checks (401 without key,
403 on config and data, no PHP source exposed, CORS preflight, no edge caching of keyed answers). Credentials live
outside the repo in `%USERPROFILE%\MuseHikData\lws-deploy.json`.

### 3.6 Android app (`frontend/android/`)

| Technology | Version | Use |
|---|---|---|
| Capacitor | 8.6 (`appId com.musehik.app`, `webDir dist/musehik-frontend/browser`) | Wraps the same Angular build |
| Android Gradle Plugin | 8.13 | Build |
| Java | 21 | Native code |
| **AndroidX Media3** (`media3-exoplayer`, `media3-session`) | 1.8.0 | Native background player: notification, lock screen, headset buttons, audio focus, plays on with screen off |
| SDK levels | min 24, target/compile 36 | — |

Native classes: `MainActivity`, `NativePlayerPlugin` (Capacitor bridge), `MusicService` (Media3 session service),
`MusicFolderPlugin` (saves songs into the phone's `Music/MuseHik` folder via Android's media index). Phone state
(cloud settings, saved songs, last cloud list for offline use) lives in `localStorage`. Installed with
`npm run android` (`frontend/scripts/android.mjs`, uses `adb` to target the USB phone).

---

## 4. Data model and storage

- **SQLite `library.db`** (`node:sqlite`): table `tracks` (`id`, `path` unique, `title`, `artist`, `album`, `duration`,
  `isrc`, `key`, `source`, `size`, `mtime_ms`, `added_at`, `added_ms`) with indexes on `key`, `isrc`, `source`;
  playlist tables added by `modules/musicPlayer/playlists.mjs`. The music folder is the files; SQLite is the index,
  reconciled with the folder on start (idea from Harmony).
- **Song identity** (used for duplicates, playlists and cloud sync): ISRC, else source id (e.g. `youtube:<id>`), else
  normalised artist + title + duration. Playlists store songs by identity, so they survive re-downloads and work across
  laptops and the phone.
- **Music folder**: one flat folder of MP3s named `Artist - Title.mp3`; instrumentals saved next to them as
  `<name> (Instrumental).mp3`, `(Instrumental, best quality)`, `(Instrumental + backing vocals)`.
- **Heavy data outside OneDrive** (`%USERPROFILE%\MuseHikData\`): separator venv, models, cloud cache (2 GB, LRU),
  dev PHP, deploy credentials.
- **Config**: `backend/config.json` (dev, git-ignored, `musicDir`), `backend/data/cloud.json` (API URL + key,
  git-ignored), `music-api/config.php` (server key, git-ignored).

---

## 5. External services and network calls

| Service | How | Why |
|---|---|---|
| YouTube | yt-dlp (search + audio download) | Audio source for every download |
| Spotify | Public embed page (no API key, no login) | Track lists of tracks/albums/playlists (metadata only) |
| Deezer | Public REST API `api.deezer.com` (no login) | Track lists + ISRCs (metadata only) |
| Cloudflare / Google DNS-over-HTTPS | `1.1.1.1/dns-query`, `8.8.8.8/resolve` | Fallback DNS for YouTube hostnames inside yt-dlp's process only |
| PyPI | pip | yt-dlp self-updates (stable / nightly) |
| Model mirrors (as in python-audio-separator) | HTTPS download | Separator model checkpoints |
| GitHub Releases (`tylerBVT/MuseHik`) | electron-updater | App updates |
| LWS shared hosting | HTTPS (music API), FTPS (deploy) | The cloud |
| Planned: LRCLIB | HTTPS | Synced lyrics |

---

## 6. Build, test, CI/CD

- **Dev run**: `MuseHik.bat` → `backend/launch.mjs` (installs what is missing, rebuilds Angular if sources changed,
  starts the server on port 3000, opens the browser).
- **Tests**: backend `node:test` (unit + integration, including the PHP API run against the laptop client both ways);
  frontend Vitest; desktop `node:test`; UI checks driving Chrome over CDP.
- **CI** (`.github/workflows/release.yml`, GitHub Actions, `windows-latest`, Node 24), triggered by a `v*` tag:
  check tag = `desktop/package.json` version → `npm ci` + `ng build` → desktop tests → `stage.mjs` →
  `electron-builder --win` → smoke test of the built app → `gh release create` with the `.exe`, `.blockmap` and
  `latest.yml`. Each step runs through `.github/run-and-report.sh`, which posts the failing output as an annotation.
- Line endings: `.gitattributes` keeps shell scripts LF.

---

## 7. Open-source projects used

### 7.1 Direct dependencies (installed packages)

| Project | License | Where |
|---|---|---|
| Angular | MIT | frontend |
| TypeScript | Apache-2.0 | frontend |
| RxJS | Apache-2.0 | frontend |
| Vitest | MIT | frontend tests |
| jsdom | MIT | frontend tests |
| Prettier | MIT | frontend |
| Capacitor (+ plugins app, filesystem, file-transfer) | MIT | Android |
| AndroidX Media3 (ExoPlayer) | Apache-2.0 | Android |
| music-metadata | MIT | backend + frontend |
| Node.js (incl. `node:sqlite`, SQLite = public domain) | MIT | backend, bundled in installer |
| Python (python.org build) | PSF License | backend, bundled in installer |
| yt-dlp + yt-dlp-ejs | Unlicense | downloader |
| FFmpeg (via imageio-ffmpeg) | LGPL/GPL (FFmpeg), BSD-2 (imageio-ffmpeg) | downloader, tags, separator |
| Electron | MIT | desktop |
| electron-builder, electron-updater | MIT | desktop |
| NSIS | zlib/libpng | installer |
| PyTorch, torchaudio | BSD-3 | separator |
| rotary-embedding-torch, einops, beartype, NumPy, PyYAML, packaging | MIT / MIT / MIT / BSD-3 / MIT / Apache-2.0+BSD | separator |
| PHP | PHP License | music API |

### 7.2 Code copied into MuseHik (with attribution in `backend/modules/instrumentalSeparator/NOTICE.md`)

| MuseHik file | Copied from | License |
|---|---|---|
| `engine/roformer/bs_roformer.py`, `mel_band_roformer.py`, `attend.py`, `rotary.py`, `device_utils.py` | **python-audio-separator** (Nomad Karaoke), model code originally by **lucidrains** (BS-RoFormer / Mel-Band RoFormer) and **ZFTurbo** | MIT |
| `engine/roformer/mel_filters.py` | **librosa** (`filters.mel`, `hz_to_mel`, `mel_to_hz`) | ISC |
| `engine/inference.py` (demix, windowing, test-time augmentation) | **Music-Source-Separation-Training (MSST)** by ZFTurbo | MIT |
| `engine/ensemble.py` (Average / Max Spec / Min Spec) | **Ultimate Vocal Remover (UVR) GUI** (Anjok07 & aufr33), via python-audio-separator | MIT |
| `engine/models.py` (download mirrors, RoFormer loading) | python-audio-separator | MIT |
| `engine/methods.py` "backing vocals" method | **karaoke-gen** (Nomad Karaoke) | MIT |

### 7.3 Projects studied for ideas and design (cloned in `openSourceProjects/`, git-ignored)

| Project | What MuseHik took from it |
|---|---|
| **Harmony** | SQLite index as source of truth, folder reconciled into it |
| **OpenCrate** / **spotDL** | Download flow: platform reads track list → library skips what exists → match on YouTube → download + tag |
| **Feishin** (GPL-3) | Player edge cases for queue / shuffle / repeat: behaviour reproduced, no code copied |
| **angular-spotify** (MIT) | Spotify-style three-column player bar layout and its component split (see `docs/PLAYER_SPEC.md`) |
| **SongMirror** | Playlist synchronisation concepts (authority, conflicts) |
| **Demucs**, **sigsep-mus-eval** | Separation models and evaluation (reference for the separator) |

---

## 8. Constraints and decisions worth knowing

- **Windows Smart App Control** shapes several choices: signed python.org Python in the installer, no librosa/numba.
- **OneDrive**: the repo may live in a OneDrive folder, so gigabyte-sized data (models, venvs, cache) lives in
  `%USERPROFILE%\MuseHikData\` instead.
- **No framework on the server** (plain `node:http`) and **no database server** anywhere (SQLite locally, JSON files
  on the hosting): fewer dependencies for a two-user app on cheap shared hosting.
- **No accounts/login**: two named profiles per laptop; the cloud is protected by one API key.
- **yt-dlp must stay current** (YouTube changes often), hence the self-updater and the writable Python copy.
- **One GPU job at a time**; one download job at a time.
- Code style: ES modules everywhere, small files per concern, comments explain *why*, pure logic split out for tests.

---

## 9. Status and roadmap

Done: downloader, library, player, playlists, cloud (music API), shared playlists, Windows installer with auto-update,
first Android player. Testing: instrumental separator. Next: official-instrumental lookup, original/instrumental
switch, synced lyrics (LRCLIB) with karaoke scrolling. Later: WhisperX lyrics alignment, BPM/beat/bar/key analysis,
writing notebook with French phonetics and rhyme finder, recording, flow score. See `OBJECTIVES.md` and
`docs/ROADMAP.md`; design documents in `docs/superpowers/specs/`.
