# MuseHik desktop app: installer, updates, profiles, music folder

Date: 2026-11-23. Status: design, waiting for approval.

## Why

MuseHik runs on the author's laptop because Node, Python and the venv are installed by hand and `MuseHik.bat` opens it in the browser. The author's mother ("MuttMutt") should get MuseHik like any other Windows app: **she downloads one installer, double-clicks it, and it works**, with nothing to install or fix by hand and no terminal. The author ("Poontje") wants an easy way to ship changes, and she gets them without doing anything technical.

## Goals

1. **A real Windows app** (Electron): its own window, desktop + Start menu icon, taskbar icon, uninstall from Windows "Installed apps". No browser, no visible terminal. Closing the window quits MuseHik.
2. **One installer, nothing else needed**: Node (Electron's), Python, yt-dlp, ffmpeg and the built Angular app are all inside it. Per-user install, no admin rights.
3. **Easy updates.** Author: one command releases a new version. Her app: notices it, downloads it in the background, shows "Update ready, restart MuseHik" with a Restart button. If she ignores it, it installs the next time she quits.
4. **Profile switch** in Settings, "Who uses this laptop?": **Poontje** or **MuttMutt**. MuttMutt hides every AI feature (today: the instrumental separator; later: lyrics alignment, studio AI).
5. **Music folder setting** in Settings: shows the current folder, a "Change..." button opens the native Windows "Select folder" window.

## Non-goals

- Code-signing certificate (costs money every year; the one-time cost is a "Windows protected your PC > More info > Run anyway" on the first install only).
- The instrumental separator in the installer (PyTorch CUDA + models are ~5 GB and need an NVIDIA GPU). It keeps working on the author's laptop through `MuseHikData`.
- macOS / Linux builds.
- Accounts, passwords, locking the profile switch (it only hides things; it is not security).

## Anti-goals (failure even if it "works")

- She ever has to open a terminal, install a program, or edit a file.
- An update loses or changes her songs, playlists, cloud settings or profile.
- A half-finished change on the author's `main` branch reaches her laptop.
- The author's current way of working (`MuseHik.bat`, `npm start`, `ng serve`, tests) breaks.

## Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Her laptop runs it from a git clone like the author's, Edge "app window", Update button does `git pull` | Least work, but the author must set up Git, Node and Python on her laptop once, and any failing `npm install` needs him | Rejected by the author: he does not want to do anything by hand on her laptop |
| **B** | **Electron app + installer (electron-builder, NSIS) + electron-updater on GitHub Releases** | More work up front (bundling Python/yt-dlp/ffmpeg, moving data out of the code folder), then nothing to do on her side | **Chosen** |
| C | Tauri | Smaller app, but the backend is Node, so it would still need a bundled Node next to a Rust shell: more parts, same result | Rejected |

## Design

### 1. Two ways to run, one codebase

- **Dev mode** (unchanged): `MuseHik.bat` / `node server.mjs` / `ng serve`. Data stays in `backend/data/`, config in `backend/config.json`, Python in `backend/.venv`, music in `downloadedMusic/` (or `musicDir`).
- **Installed mode** (new): the Electron app. The code folder is read-only (`Program Files`-like, inside `resources/`), so everything that changes lives elsewhere:

| What | Installed-mode location |
|---|---|
| Settings (profile, music folder, cloud, yt-dlp updater state), `library.db` | `%APPDATA%\MuseHik\` |
| Music (default, changeable in Settings) | `%USERPROFILE%\Music\MuseHik\` |
| yt-dlp (updatable copy), cloud cache, logs | `%LOCALAPPDATA%\MuseHik\` |
| Separator venv + models (Poontje only, optional) | `~\MuseHikData\` as today |

`backend/core/config.mjs` decides the mode from one env var set by Electron (e.g. `MUSEHIK_APP_DATA`), so every module keeps importing paths from one place.

### 2. Electron shell (new `desktop/` folder)

- Main process starts the existing backend (`server.mjs` `start()`), on `127.0.0.1` and a free port, then opens a `BrowserWindow` on it. CORS allowed origins follow the real port.
- Single-instance lock: double-clicking the icon again focuses the open window.
- Closing the window stops the server and quits (stop running downloads cleanly, as the server does today).
- Window size/position remembered. App icon from a MuseHik logo (to make).
- A small `preload` exposes `window.musehik.pickFolder()` (native `dialog.showOpenDialog({ properties: ['openDirectory'] })`) and update events. The Angular app checks if `window.musehik` exists; in dev mode (browser) it falls back to a server endpoint that opens the Windows folder dialog via PowerShell, so the setting also works in `MuseHik.bat` mode.
- Electron's built-in Node must support `node:sqlite` (Node >= 22.13, i.e. a recent Electron). Pick the newest stable Electron at build time.

### 3. Python, yt-dlp, ffmpeg inside the installer

- Ship the official python.org Python (NuGet package "python", signed by the PSF) in the app resources. Not python-build-standalone: its DLLs are unsigned and Windows Smart App Control blocks them (seen on the author's laptop with `_ssl.pyd`).
- On first start, create a venv in `%LOCALAPPDATA%\MuseHik\venv` from it and copy in the yt-dlp + imageio-ffmpeg packages that were pre-installed at build time (so the first start needs no internet and no pip download). The existing pip-based **yt-dlp auto-updater** (`updater.mjs`) then works unchanged on that venv, which matters because YouTube breaks yt-dlp every few weeks.
- `ytdlp_launcher.py` (DNS fallback) is kept as is: harmless where YouTube is not blocked.
- yt-dlp-ejs needs a JavaScript runtime for YouTube challenges. Today `engine.mjs` passes `--js-runtimes node` and yt-dlp finds the system Node. In installed mode, **ship `node.exe` in the installer** (~30 MB compressed) and pass `--js-runtimes node:<path to bundled node.exe>`. (Rejected: running Electron's own binary as Node with `ELECTRON_RUN_AS_NODE=1`; free but fragile across Electron/yt-dlp versions.) Verified with a real YouTube download on a Windows account without Node installed.

### 4. Releases and updates

- **Author side**: `npm version patch` (or minor) in `desktop/`, then push the tag. A GitHub Actions workflow on `windows-latest` (free for public repos) builds Angular, packs the app with electron-builder, and publishes the installer + `latest.yml` to a GitHub Release on `tylerBVT/MuseHik`. Only tagged versions reach her, so work in progress on `main` never does.
- **First install**: the author sends her the link to the latest release's `MuseHik-Setup-x.y.z.exe`.
- **Her side**: electron-updater checks at start and every 4 hours. When a new version is downloaded, a banner in the app: "A new version of MuseHik is ready. [Restart now]". Otherwise it installs on quit. Settings shows the current version and a "Check for updates" button.
- The installer is unsigned: SmartScreen warns on the first manual install only. Updates downloaded by the app itself do not show it.
- Updates never touch `%APPDATA%\MuseHik`, the music folder or `%LOCALAPPDATA%\MuseHik\venv` (the venv is rebuilt only if the bundled Python version changes).

### 5. Profile switch (Settings > "Who uses this laptop?")

- Two choices: **Poontje**, **MuttMutt**. Saved in the settings file (per laptop).
- Default: **MuttMutt** on a fresh install; **Poontje** when the separator venv exists (`~\MuseHikData\separator-venv`) or in dev mode. So the author's laptop needs no change and hers starts right.
- MuttMutt hides: the separator page, its home tile / nav entry, and any separator actions in song menus. Future AI features check the same flag. The server does not need to refuse anything (no separator venv on her laptop anyway).
- One `profile` signal in the Angular app (e.g. in a small `settings.service.ts`) and an `isAiAllowed` computed that features read.

### 6. Music folder setting (Settings > "Music folder")

- Shows the current folder path and the number of songs; "Change..." opens the native folder picker.
- After a folder is picked, one question: **"Move my N songs there"** (default) or **"Use this folder as it is"** (for pointing at an existing music collection; the old songs stay where they are and leave the library).
- Refused (with a message) while a download, cloud transfer or separation is running.
- Then: save the setting, switch the folder live (no app restart), rescan the library. Playlists survive because they store songs by identity, not by path. The cloud cache is not affected.
- Code change: `outputDir` is today a constant read once at start (`backend/core/config.mjs:22`) and imported in about 6 modules (library scan, downloader, cloud save, separator results). It becomes a getter (`musicDir()`) plus a `setMusicDir()` that saves and triggers the rescan. Priority stays: `MUSIC_DIR` env > saved setting > `config.json` `musicDir` > default.

### 7. Cloud on her laptop

The FTP login is **never** put in the installer (the repo and its releases are public). She types it once in Settings > Cloud, the screen that already exists; it is then kept in `%APPDATA%\MuseHik` across updates.

## Left to the builder

- Exact Electron version, electron-builder config, how the backend runs inside Electron (main process vs `utilityProcess`).
- How the JS runtime for yt-dlp-ejs is provided (section 3), verified on a clean Windows user account / VM.
- Build-time packaging of Python + yt-dlp (script in `desktop/`), and venv repair if it is found broken at start.
- App icon and banner styling (follow the existing theme).
- Tests: config path resolution in both modes, `setMusicDir` move/use-as-is, profile default rules, plus one real install test on a clean Windows account before sending it to her.

## Calls made by Claude (check these)

- Electron + electron-builder NSIS + electron-updater on GitHub Releases of the existing public repo, built by GitHub Actions on a version tag.
- Updates install on "Restart now" or on quit, never in the middle of use.
- Data in `%APPDATA%\MuseHik`, music default `Music\MuseHik`, dev mode unchanged.
- Bundled standalone Python so the existing yt-dlp auto-updater keeps working (instead of the standalone `yt-dlp.exe`).
- Profile default: MuttMutt on fresh installs, Poontje where the separator is installed.
- Changing the music folder offers "move songs" (default) or "use as it is".
