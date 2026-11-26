# MuseHik

**MuseHik is a personal music app for Windows (and, early on, Android).** Paste a YouTube, Spotify or Deezer link and
the songs land in your library as tagged MP3s. Play them, make playlists, share them through your own small cloud
between laptops and a phone, and turn any song into its **instrumental** with AI.

The long-term goal is a **French rap studio**: a song goes in, and its instrumental, synced lyrics and beat grid come
out, so you can listen, sing along and write your own lyrics on the beat.

> Current version: **v1.0.4** (2026-11). Downloader, library, player, cloud, shared playlists and the Windows app all
> work. The AI instrumental separator works and is being tested. Lyrics, beat analysis and the studio are planned.
> Full technical description: [`TECHNICAL_EXPLANATION.md`](TECHNICAL_EXPLANATION.md).

---

## What you can do with it

| Feature | What it means for you |
|---|---|
| **Download** | Paste a link to a song, album or playlist (YouTube, Spotify or Deezer). MuseHik finds each song, saves it as an MP3 with title, artist, album and cover, and skips songs you already have. |
| **Library + player** | Search, sort and play your songs. Shuffle, repeat, a mini player and a full-screen player, keyboard media keys. |
| **Playlists** | Make playlists; they keep working even if a song is deleted and downloaded again. |
| **Cloud** | Put songs on your own web hosting (up to 30 GB) and listen to them from any laptop. Songs start playing while they download and are cached afterwards. An Online/Offline switch per laptop. |
| **Shared playlists** | Flip "Shared" on a playlist and the other laptop sees it (and its songs) as "from &lt;name&gt;". |
| **Instrumental (AI)** | Pick a song, choose *Fast*, *Best quality* or *Keep backing vocals*, and get its instrumental as an MP3 next to the original. Needs an NVIDIA GPU and a one-time setup (see below). |
| **Updates** | The Windows app updates itself. |

---

## Install it (Windows, nothing else needed)

1. Download **`MuseHik-Setup-x.y.z.exe`** from the [latest release](https://github.com/tylerBVT/MuseHik/releases/latest).
2. Double-click it. The first time, Windows says *"Windows protected your PC"* because the installer is not signed:
   click **More info**, then **Run anyway**.
3. MuseHik opens in its own window, and is now in the Start menu, in Windows search and on the desktop.

When a new version is ready, a bar says *"A new version of MuseHik is ready"* with **Restart now**.

### Your first five minutes

1. **Settings > Music folder**: pick where your songs go (default: `Music\MuseHik`). Songs already in that folder are
   added to the library.
2. **Download**: paste a link (for example a Spotify playlist) and press the button. Watch the progress; you can stop
   at any time and *Try again* later, finished songs are skipped.
3. **Library**: click a song to play it. Use the ⋮ menu on a song to rename it, change its genre or delete it.
4. *(Optional)* **Settings > Cloud**: enter your music API address and key (see [The cloud](#the-cloud-optional)).
5. *(Optional)* **Settings > Who uses this laptop**: *Poontje* sees the AI tools, *MuttMutt* does not. A new install
   starts as MuttMutt unless the instrumental separator is installed.

### Where your files are

| What | Where |
|---|---|
| Songs | `Music\MuseHik\` (or the folder you chose) |
| Settings, library index, playlists | `%APPDATA%\MuseHik\` |
| Built-in Python + yt-dlp, cloud cache, log (`logs\server.log`) | `%LOCALAPPDATA%\MuseHik\` |

Uninstalling MuseHik keeps all of these.

---

## The cloud (optional)

The cloud is a small PHP program (the **music API**, in `music-api/`) that you put on any PHP web hosting. It stores
the songs and shared playlists; the laptops and the phone talk to it over HTTPS with a secret key.

- To set it up on a hosting: see [`music-api/README.md`](music-api/README.md) (the author's hosting is LWS, deployed
  with `node music-api/deploy.mjs`).
- On each laptop: **Settings > Cloud**, paste the API address and key, press *Test connection*.
- Turn **Use the cloud on this laptop** off to go Offline: MuseHik then never connects.

## The Android app (early)

A phone version of the player that plays songs from the cloud and can save them on the phone. It has no downloader
and no AI tools (those need the laptop's server). It is installed from the code for now (see *For developers*).

## The instrumental separator (optional, needs an NVIDIA GPU)

It runs AI models (RoFormer) on your graphics card. Setup, once, in PowerShell:

```powershell
cd $env:USERPROFILE\MuseHikData
py -3.13 -m venv separator-venv
.\separator-venv\Scripts\python.exe -m pip install --resume-retries 50 torch torchaudio --index-url https://download.pytorch.org/whl/cu128
.\separator-venv\Scripts\python.exe -m pip install -r <MuseHik folder>\backend\modules\instrumentalSeparator\requirements.txt
```

The models (200 to 900 MB each) download by themselves the first time they are used. Details, timings and methods:
[`backend/modules/instrumentalSeparator/README.md`](backend/modules/instrumentalSeparator/README.md).

---

## For developers

### What you need

- **Windows** (the app is built and tested there)
- **Node.js 24** and **Python 3** (3.13 or newer)
- Optional: **PHP 8.1+** for the cloud tests, **Android Studio + Java 21** for the phone app, an **NVIDIA GPU** for the separator

### Get it running from the code

```powershell
git clone https://github.com/tylerBVT/MuseHik.git
cd MuseHik

# Backend (Node server + Python for yt-dlp)
cd backend
npm install
copy config.example.json config.json      # then set "musicDir" (use \\ in paths)
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..

# Frontend (Angular)
cd frontend
npm install
cd ..
```

Then **double-click `MuseHik.bat`**. It builds the Angular app if needed, starts the server on
`http://127.0.0.1:3000` and opens it in your browser. Close its window to stop it.

Other ways to run it:

| Goal | Command |
|---|---|
| Front end with live reload | `cd frontend && npm start` (port 4200) while the backend runs (`cd backend && npm start`) |
| The app window, without installing | `cd desktop && npm install && npm start` |
| A local copy of the cloud API | `cd backend && node tests/music-api-dev.mjs` (prints its address and key) |
| The Android app on a USB phone | `cd frontend && npm run android` (USB debugging on, Android SDK + Java 21) |

### Tests

| Where | Command |
|---|---|
| Backend | `cd backend && npm test` (cloud tests are skipped when no PHP is found; set `MUSEHIK_PHP` to a `php.exe`) |
| Frontend | `cd frontend && npm test` |
| Desktop | `cd desktop && npm test` |
| Browser checks | `node backend/tests/ui-*.mjs` (drive Chrome against the running app) |

### Release a new version

From `main`, with everything committed: `cd desktop && npm run release` (or `npm run release minor`). It runs the
tests, bumps the version, tags and pushes; GitHub Actions builds the installer and publishes the release, and
installed apps update themselves. To build an installer locally without publishing: `cd desktop && npm run dist`
(output in `desktop/dist/`).

### Where the code is

```text
frontend/            Angular app (the whole user interface, for Windows and Android)
  src/app/features/    musicDownloader, musicPlayer, instrumentalSeparator, cloud
  android/             Android project (Capacitor + native player)
backend/             Node server: the /api, the library (SQLite), runs yt-dlp, ffmpeg and the AI separator
  core/                config, library index, tags, helpers
  modules/             musicDownloader, musicPlayer, instrumentalSeparator, cloud, app (each has routes.mjs)
  tests/               automated tests and browser checks
desktop/             Electron shell + installer + auto-update
music-api/           PHP cloud API that goes on the web hosting
docs/                roadmap, player spec, design documents (docs/superpowers/specs/)
openSourceProjects/  third-party repos cloned for reading only (not in git)
```

More reading:
- [`TECHNICAL_EXPLANATION.md`](TECHNICAL_EXPLANATION.md): the full tech stack, architecture and every open-source project used
- [`OBJECTIVES.md`](OBJECTIVES.md): detailed log, decisions and findings
- [`docs/ROADMAP.md`](docs/ROADMAP.md): future infrastructure notes
- Vision board: [Studio Rap FR — carte des services](https://claude.ai/artifact/J1x1VAdYquncSbndiRqqEP)

---

## Roadmap

```text
Source            ->  Download + Player  ->  Separation        ->  Lyrics          ->  Analysis           ->  Studio
YouTube/Deezer/       done                    vocals/instru         synced (LRC)        BPM, beats, bars       karaoke + notebook + rhymes
Spotify link                                  testing               todo                todo                   todo
```

- **Next:** find an official "(Instrumental)" release before using AI; a player switch original / instrumental;
  synced lyrics (LRCLIB) with karaoke scrolling; a fuller Android app.
- **Later:** lyrics alignment (WhisperX), music analysis (BPM, beats, bars, key), a writing notebook with a French
  rhyme finder, a bar-by-bar training mode.
- **Ideas:** voice recording on the instrumental, flow score, type-beat catalogue, accounts.

## Legal note

Downloading from YouTube may break its terms of service, and copyrighted music should only be saved with
permission. MuseHik is a personal-use project. Third-party code in the separator is listed with its licenses in
[`backend/modules/instrumentalSeparator/NOTICE.md`](backend/modules/instrumentalSeparator/NOTICE.md).
