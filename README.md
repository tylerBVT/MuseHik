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
| Short term | **Cloud**: upload songs (picked, a playlist, or any folder) to the LWS hosting over FTP; listen from any laptop; 10 GB/month traffic and 30 GB storage limits with a usage bar | **Done, tested on a local FTP server**; not yet tried against the real hosting ([design](docs/superpowers/specs/2026-11-21-cloud-design.md)) |
| Short term | **Shared playlists**: a Shared switch puts a playlist (and its songs) on the cloud; the other laptop sees it as "from <name>". Playlists store songs by identity, so they survive re-downloads and work on any laptop | **Done**, tested on a local FTP server ([design](docs/superpowers/specs/2026-11-21-shared-playlists-design.md)) |
| Short term | **Official instrumental lookup**: find an "(Instrumental)" release before falling back to AI separation | Todo |
| Short term | Player switch **original / instrumental only** | Todo (needs the separator) |
| Short term | **Synced lyrics** (LRC from LRCLIB) + karaoke scrolling | Todo |
| Medium term | Lyrics alignment with WhisperX on the isolated vocals; music analysis (BPM, beats, bars, key) | Todo |
| Medium term | Writing notebook, French phonetic engine, rhyme finder, theme search, bar-by-bar training mode | Todo |
| Long term | Voice recording on the instrumental, flow score, type-beat catalogue, GPU job queue, cloud + accounts, mobile app | Ideas |

## Run it

Double-click `MuseHik.bat` (needs Node.js). It starts the server and opens the app in the browser.

Developer setup:
- `backend/`: `npm install`, copy `config.example.json` to `config.json`, Python venv in `backend/.venv`: `pip install -r requirements.txt` (yt-dlp then keeps itself up to date, see Settings). `npm test` runs the tests.
- `frontend/`: Angular app, `npm install` then `npm start` (or built into `frontend/dist`, served by the backend).
- Instrumental separator: its own Python venv (PyTorch CUDA) and the AI models live **outside OneDrive** in `C:\Users\<you>\MuseHikData\` (`separator-venv\`, `models\`), so gigabytes are not synced. Change it with `heavyDir` in `config.json` or the `MUSEHIK_HEAVY_DIR` env var.
  Install: `MuseHikData\separator-venv\Scripts\python.exe -m pip install --resume-retries 50 torch torchaudio --index-url https://download.pytorch.org/whl/cu128`
- Cloud: fill in Settings > Cloud (FTP host, user, password, folder). Saved in `backend/data/cloud.json` (git-ignored). Played cloud songs are cached in `MuseHikData\cloudCache\` (2 GB). `node tests/ui-cloud.mjs` checks the cloud pages in Chrome against a throw-away FTP server.

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
