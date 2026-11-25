# MuseHik

A personal music app that is growing into a **French rap studio**: a song goes in, and its instrumental, its lyrics and its beat grid come out, so you can listen, sing along and write your own texts on the beat.

> Status (2026-11-17): **downloader + library + player work** (Windows, in the browser, one-click launcher).
> **Instrumental separator: first version works** (3 methods, GPU), waiting for listening tests. Everything after it is planned, not started.
> Vision board (all next steps): [Studio Rap FR — carte des services](https://claude.ai/artifact/J1x1VAdYquncSbndiRqqEP), translated in [`OBJECTIVES.md`](OBJECTIVES.md).
> Detailed log, decisions and findings: [`OBJECTIVES.md`](OBJECTIVES.md). Future infrastructure notes: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## The path of a song

```text
Source            ->  Downloader + Player  ->  Separation       ->  Lyrics        ->  Analysis             ->  Studio
YouTube/Deezer/       done                     vocals/instru        synced (LRC)      BPM, beats, bars         karaoke + notebook + rhymes
Spotify link                                   IN PROGRESS          todo              todo                     todo
```

## Where we are

| Stage | Feature | Status |
|---|---|---|
| Short term | **Downloader**: YouTube / Spotify / Deezer link -> tagged MP3 in the library (yt-dlp + ffmpeg) | Done |
| Short term | **Player + library**: SQLite index, search, playlists, mini + full-screen player, media keys | Done |
| Short term | **Instrumental separation**: MP3 in -> best possible instrumental MP3 out (RoFormer / Demucs models, ensembles) | **First version, testing**: pick a song + Fast / Best quality / Keep backing vocals, progress bar, listen, compare, download. Engine: RoFormer models + MSST TTA + UVR ensembles + karaoke-gen backing vocals ([module README](backend/modules/instrumentalSeparator/README.md)) |
| Short term | **Cloud**: upload songs (picked, a playlist, or any folder) to the LWS hosting (over FTP until 2026-11-24, now through the music API); listen from any laptop; 30 GB storage limit with a usage bar; songs put in `music/songs/` with FileZilla show up; sort and filter by date | **Done, works on the real hosting** (first test 2026-11-23) ([design](docs/superpowers/specs/2026-11-21-cloud-design.md)) |
| Short term | **Cloud, live**: songs start while they download; one kept-open connection for listening, one for transfers; Online/Offline switch per laptop (Offline never connects); ⋮ menu on every song (rename, genre, delete); Download to cloud; Download from cloud | **Built, tested on a local FTP server** ([design](docs/superpowers/specs/2026-11-23-cloud-live-design.md)) |
| Short term | **Windows app**: installer, in-app updates from GitHub Releases, profile switch (Poontje / MuttMutt), music folder picker | **Built** ([design](docs/superpowers/specs/2026-11-23-desktop-app-design.md)) |
| Short term | **Shared playlists**: a Shared switch puts a playlist (and its songs) on the cloud; the other laptop sees it as "from <name>". Playlists store songs by identity, so they survive re-downloads and work on any laptop | **Done**, tested on a local FTP server ([design](docs/superpowers/specs/2026-11-21-shared-playlists-design.md)) |
| Short term | **Official instrumental lookup**: find an "(Instrumental)" release before falling back to AI separation | Todo |
| Short term | Player switch **original / instrumental only** | Todo (needs the separator) |
| Short term | **Synced lyrics** (LRC from LRCLIB) + karaoke scrolling | Todo |
| Medium term | Lyrics alignment with WhisperX on the isolated vocals; music analysis (BPM, beats, bars, key) | Todo |
| Medium term | Writing notebook, French phonetic engine, rhyme finder, theme search, bar-by-bar training mode | Todo |
| Long term | Voice recording on the instrumental, flow score, type-beat catalogue, GPU job queue, cloud + accounts, mobile app | Ideas |

## Run it

**The Windows app (for anyone, nothing else to install):** download `MuseHik-Setup-x.y.z.exe` from the
[latest release](https://github.com/tylerBVT/MuseHik/releases/latest) and double-click it. Windows shows
"Windows protected your PC" the first time (the installer is not signed): **More info > Run anyway**. MuseHik then
appears in the Start menu, in Windows search and on the desktop, and opens in its own window. It updates itself:
when a new version is downloaded, a bar says "A new version of MuseHik is ready" with **Restart now**.
- Its settings and library index live in `%APPDATA%\MuseHik\`, songs in `Music\MuseHik\` (change it in Settings > Music folder),
  its Python + yt-dlp copy, cloud cache and log (`logs\server.log`) in `%LOCALAPPDATA%\MuseHik\`. Uninstalling keeps them.
- Settings > Who uses this laptop: **Poontje** sees the AI tools, **MuttMutt** does not. A new install starts as MuttMutt,
  except where the instrumental separator is installed.

**Release a new version** (from `main`, everything committed): `cd desktop && npm run release` (or `release minor`).
It runs the tests, bumps the version, tags and pushes; GitHub Actions builds the installer and publishes it, and
installed apps pick it up. Build an installer locally without publishing: `cd desktop && npm run dist` (output in `desktop/dist/`).
Try the app window without installing: `cd desktop && npm start` (uses this folder's backend, data and Python).

**From the code (development):** double-click `MuseHik.bat` (needs Node.js). It starts the server and opens the app in the browser.

**Music API (`music-api/`, PHP, goes to LWS):** the cloud for the laptops and the phone (songs, streaming with
seeking, uploads, renames, songs added by hand, storage, shared playlists). The laptops no longer use FTP. Try it on this laptop with
`cd backend && node tests/music-api-dev.mjs`; details and curl commands in `music-api/README.md`.

**Android phone (early, player shell only):** plug the phone in by USB (USB debugging on), then `cd frontend && npm run android`.
It builds the same Angular app, packages it with Capacitor (`frontend/android/`) and installs and starts it on the phone.
Needs the Android SDK (Android Studio) and Java 21. On the phone there is no server, so `core/platform.ts` (`hasServer`)
hides the downloader, separator, cloud and playlist pages; the library is empty for now.

Developer setup:
- `backend/`: `npm install`, copy `config.example.json` to `config.json`, Python venv in `backend/.venv`: `pip install -r requirements.txt` (yt-dlp then keeps itself up to date, see Settings). `npm test` runs the tests.
- `frontend/`: Angular app, `npm install` then `npm start` (or built into `frontend/dist`, served by the backend).
- Instrumental separator: its own Python venv (PyTorch CUDA) and the AI models live **outside OneDrive** in `C:\Users\<you>\MuseHikData\` (`separator-venv\`, `models\`), so gigabytes are not synced. Change it with `heavyDir` in `config.json` or the `MUSEHIK_HEAVY_DIR` env var.
  Install: `MuseHikData\separator-venv\Scripts\python.exe -m pip install --resume-retries 50 torch torchaudio --index-url https://download.pytorch.org/whl/cu128`
- Cloud: fill in Settings > Cloud (the music API's address and key, from `config.php` on the hosting). "Use the cloud on this laptop" off = Offline: no connection at all. Saved in `backend/data/cloud.json` (git-ignored). Played cloud songs are cached in `MuseHikData\cloudCache\` (2 GB). `node tests/ui-cloud.mjs` checks the cloud pages in Chrome against a throw-away music API. The cloud tests need PHP (`%USERPROFILE%MuseHikDataphp-8.1` or `MUSEHIK_PHP`).

## Code layout (by module)

```text
frontend/src/app/features/   musicDownloader, musicPlayer, instrumentalSeparator, cloud
backend/core/                config, SQLite library, helpers
backend/modules/             musicDownloader, musicPlayer, instrumentalSeparator, cloud (each exposes routes.mjs)
openSourceProjects/          third-party repos cloned for reading only (git-ignored); the 6 separation repos are in MuseHikData/openSourceProjects/
docs/                        player spec, roadmap
```

## Stack

Angular front end, Node server with no framework, SQLite (`node:sqlite`), Python for the heavy lifting (yt-dlp, separation models).
Runs locally on Windows; Android (Capacitor) and a remote library are later steps described in `docs/ROADMAP.md`.

## Legal note

Downloading from YouTube may break its terms of service, and copyrighted music should only be saved with permission. Personal-use project.
