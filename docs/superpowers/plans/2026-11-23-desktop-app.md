# MuseHik Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MuseHik as a Windows app with an installer and in-app updates, plus a profile switch (Poontje / MuttMutt) and a music folder picker in Settings.

**Architecture:** A new `desktop/` Electron shell starts the existing backend as a child process with a bundled `node.exe`, then shows the built Angular app in its own window. The backend learns its data/music/web locations from env vars set by the shell (dev mode keeps today's defaults). electron-builder makes an NSIS installer that also carries a standalone Python with yt-dlp + imageio-ffmpeg; GitHub Actions builds and publishes it on a version tag; electron-updater installs updates.

**Tech Stack:** Electron (newest stable), electron-builder (NSIS), electron-updater (GitHub provider), Node 24 LTS `node.exe`, python-build-standalone CPython 3.12 (`install_only`, x86_64-pc-windows-msvc), Angular 22 signals, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-desktop-app-design.md`

## Global Constraints

- Dev mode must keep working unchanged: `MuseHik.bat`, `node server.mjs`, `ng serve`, `npm test` in `backend/`.
- Installed-mode locations: settings + `library.db` in `%APPDATA%\MuseHik\`; music default `%USERPROFILE%\Music\MuseHik\`; Python copy, cloud cache, logs in `%LOCALAPPDATA%\MuseHik\`; separator stays in `~\MuseHikData\`.
- Profiles: exactly `poontje` and `muttmutt` (labels "Poontje", "MuttMutt"). MuttMutt hides every AI feature. Default: saved value, else `poontje` in dev mode or when `separatorPython` exists, else `muttmutt`.
- Music folder change: refused while a download, cloud upload, cloud save or separation is running. Choices: "Move my N songs there" (default) / "Use this folder as it is". Priority: `MUSIC_DIR` env > saved setting > `config.json` `musicDir` > default.
- Never put cloud credentials in the installer or the repo.
- yt-dlp JS runtime: always `--js-runtimes node:<process.execPath>` (the Node running the server).
- Updates: check at start and every 4 h, download in background, banner "A new version of MuseHik is ready." with "Restart now", otherwise install on quit. Publish to GitHub Releases of `tylerBVT/MuseHik`.
- Installed app server port is fixed: **38517** on `127.0.0.1` (localStorage is per origin; a changing port would forget the theme etc.).
- Per-user install, no admin; desktop + Start menu shortcuts; unsigned.

## Review Focus

1. **Closing the window during a download**: no `node.exe`, `python.exe`, or `ffmpeg.exe` left running (Task 5 step: kill-tree check).
2. **Music folder on another drive** (`rename` fails with `EXDEV`): files are copied then deleted, ids/playlists/added dates kept (Task 2 test `moves across devices`).
3. **Folder path with a space and an accent** (`C:\Users\Mütti\Ma musique`): picking, moving, scanning and streaming work (Task 2 test uses such a name).
4. **Port 38517 already taken**: the app shows "MuseHik could not start: port 38517 is in use" instead of a blank window (Task 5 error page).
5. **An app update that changes the bundled Python**: the Python copy is replaced; one that doesn't change it leaves the user's yt-dlp update alone (Task 5 tests on `ensurePython`).

---

### Task 1: Backend config: data locations, app settings, live music folder

**Files:**
- Modify: `backend/core/config.mjs`
- Modify (replace `outputDir` with `musicDir()`): `backend/core/library.mjs`, `backend/modules/cloud/save.mjs`, `backend/modules/instrumentalSeparator/jobs.mjs` (`resultsDir` becomes a function `resultsDir()`), `backend/modules/musicDownloader/engine.mjs`, `backend/modules/musicDownloader/jobs.mjs`, `backend/modules/musicDownloader/migrate-flat.mjs`, `backend/server.mjs`
- Modify: `backend/core/static.mjs` (`webRoot` = `process.env.MUSEHIK_WEB_ROOT` || today's path)
- Test: `backend/tests/app-settings.test.mjs`

**Interfaces:**
- Produces (from `core/config.mjs`):
  - `dataDir: string` = `process.env.MUSEHIK_DATA_DIR` || `backend/data`
  - `installed: boolean` = `process.env.MUSEHIK_INSTALLED === '1'`
  - `loadAppSettings(): { profile?: 'poontje'|'muttmutt', musicDir?: string }` (file `<dataDir>/app-settings.json`, missing = `{}`)
  - `saveAppSettings(patch): object` (merge + write; throws `Unknown profile "x".` for other profiles; `musicDir` must be absolute)
  - `musicDir(): string` (priority from Global Constraints; default = `process.env.MUSEHIK_DEFAULT_MUSIC_DIR` || `<repo>/downloadedMusic`)
  - `profile(): 'poontje'|'muttmutt'` (default rule from Global Constraints)
  - `outputDir` is removed (every importer switches to `musicDir()`).

- [ ] **Step 1: Write the failing tests** in `backend/tests/app-settings.test.mjs` (set env before importing config: `MUSEHIK_DATA_DIR` = tmp dir, `SEPARATOR_PYTHON` = a missing path, delete `MUSIC_DIR`):
  - `musicDir follows the saved setting` — `saveAppSettings({ musicDir: X })` then `musicDir() === X`.
  - `MUSIC_DIR env wins over the saved setting`.
  - `musicDir defaults to MUSEHIK_DEFAULT_MUSIC_DIR` when nothing is saved.
  - `relative musicDir is refused` — throws.
  - `profile defaults to poontje in dev mode` (MUSEHIK_INSTALLED unset).
  - `profile defaults to muttmutt when installed without the separator` (set `MUSEHIK_INSTALLED=1` before import; use a second test file only if import-time env makes it impossible in one: then `app-settings-installed.test.mjs`).
  - `saved profile wins`, `unknown profile is refused`.
- [ ] **Step 2: Run** `cd backend && node --test tests/app-settings.test.mjs` — expect FAIL (exports missing).
- [ ] **Step 3: Implement** the exports in `config.mjs`; `profile()` and `musicDir()` read the file on each call (small JSON, called rarely). Replace every `outputDir` import; in `instrumentalSeparator/jobs.mjs` make `resultsDir()` and update `resultPath`. `server.mjs` log line uses `musicDir()`.
- [ ] **Step 4: Run** `cd backend && npm test` — expect all PASS (existing tests set `MUSIC_DIR`, so they keep working).
- [ ] **Step 5: Commit** `feat(backend): app settings file, live music folder, data dir from env`

---

### Task 2: Backend `app` module: profile, folder picker, change music folder

**Files:**
- Create: `backend/modules/app/routes.mjs`, `backend/modules/app/musicFolder.mjs`
- Create: `backend/core/pickFolder.mjs` (move `pickFolder` out of `modules/cloud/upload.mjs`, add a `description` parameter; cloud keeps importing it)
- Modify: `backend/core/library.mjs` (add `movePath(from: string, to: string): void` — `UPDATE tracks SET path = ? WHERE path = ?`)
- Modify: `backend/modules/instrumentalSeparator/jobs.mjs` (add `export const separating = () => boolean` — any job queued or running)
- Modify: `backend/server.mjs` (add the module to `modules`)
- Test: `backend/tests/music-folder.test.mjs`

**Interfaces:**
- Consumes: Task 1 `musicDir()`, `saveAppSettings()`, `profile()`, `installed`; `activeJob()` (downloader), `activeUpload()`, `activeSave()` (cloud), `separating()`; `scanLibrary()`, `freePath()`, `listTracks()`.
- Produces (HTTP):
  - `GET /api/app` → `{ profile, musicDir, songs: number, installed: boolean, version: string|null }` (`version` = `process.env.MUSEHIK_VERSION` || null)
  - `PUT /api/app/profile` body `{ profile }` → same shape as GET
  - `POST /api/app/music-folder/pick` → `{ path: string|null }` (dialog text "Choose the folder where MuseHik keeps your music")
  - `POST /api/app/music-folder` body `{ path, move: boolean }` → `{ musicDir, moved: number, failed: { file, error }[], total: number }`; 409 `{ error }` when busy; 400 for bad paths.
- Produces (JS): `changeMusicDir(path: string, { move }: { move: boolean }): Promise<result above>` in `musicFolder.mjs`.

- [ ] **Step 1: Write the failing tests** in `backend/tests/music-folder.test.mjs` (tmp `MUSEHIK_DATA_DIR`, `LIBRARY_DB`, `CLOUD_SETTINGS`; music folders named `Ma musique` and `Mütti music` to cover spaces/accents; songs via `makeMp3`; drive the real server like `library-edit.test.mjs`):
  - `GET /api/app reports profile, folder and song count`.
  - `move: files land in the new folder, ids and added dates are kept, a playlist still lists them`.
  - `move: a name clash gets a free name, nothing is overwritten`.
  - `moves across devices` — stub `fs.promises.rename` to throw `{ code: 'EXDEV' }` once (inject via an exported `setRename(fn)` test hook in `musicFolder.mjs`); file still moved, original gone.
  - `use as it is: old songs leave the library, songs already in the new folder appear`.
  - `refused while a download runs` → 409 and the error text `Wait until the download, upload or separation is finished.` (simulate with a test hook `setBusyCheck(fn)`).
  - `refused: same folder, missing folder, a folder inside the current one, the current one inside it` → 400.
  - `PUT /api/app/profile switches profile; unknown profile is 400`.
- [ ] **Step 2: Run** `cd backend && node --test tests/music-folder.test.mjs` — expect FAIL.
- [ ] **Step 3: Implement.** `changeMusicDir`: validate (absolute, exists, is dir, not same/nested, compared case-insensitively on Windows); busy check; if `move`, for each audio file at the top level of the old folder: target = `freePath(newDir, base, ext)`, rename (on `EXDEV`: `copyFile` + `unlink`), `movePath(old, target)`, collect per-file failures and continue; then `saveAppSettings({ musicDir })`, `scanLibrary()`. Routes follow the `handle(req, { res, json })` pattern.
- [ ] **Step 4: Run** `cd backend && npm test` — all PASS.
- [ ] **Step 5: Commit** `feat(backend): profile and music folder API`

---

### Task 3: Backend runs inside the app: yt-dlp runtime and clean quit

**Files:**
- Modify: `backend/modules/musicDownloader/engine.mjs:111` (`'--js-runtimes', \`node:${process.execPath}\``)
- Modify: `backend/server.mjs` (export `stop(): Promise<void>` — cancel running download/upload/save/separation jobs, close FTP lanes (`closeLanes()`), close the server; when `process.send` exists, `process.on('message', m => m === 'quit' && stop().then(() => process.exit(0)))`; port from `PORT` as today)
- Test: `backend/tests/lib.test.mjs` (add one test)

**Interfaces:**
- Produces: the IPC contract Task 5 uses: parent sends the string `'quit'`; child exits 0 within 5 s.

- [ ] **Step 1: Add test** `ytdlp uses the Node that runs the server` — `ytdlpArgs([])` contains `node:${process.execPath}` right after `--js-runtimes`.
- [ ] **Step 2: Run** `node --test tests/lib.test.mjs` — FAIL.
- [ ] **Step 3: Implement** both changes.
- [ ] **Step 4: Run** `npm test` — PASS. Then manual: `node -e "const c=require('child_process').fork('server.mjs',{env:{...process.env,PORT:'38599'}});setTimeout(()=>c.send('quit'),4000);c.on('exit',x=>console.log('exit',x))"` from `backend/` prints `exit 0`.
- [ ] **Step 5: Commit** `feat(backend): yt-dlp uses the server's Node, clean quit over IPC`

---

### Task 4: Frontend: profile, music folder, update banner

**Files:**
- Create: `frontend/src/app/core/app-settings.service.ts`
- Create: `frontend/src/app/shared/update-banner.ts` (standalone component, inline template)
- Create: `frontend/src/app/core/desktop.ts` (type of `window.musehik`, `export const desktop: MuseHikDesktop | undefined`)
- Modify: `frontend/src/app/settings/settings.{ts,html,css}`, `frontend/src/app/home/home.{ts,html}`, `frontend/src/app/app.{ts,html}`
- Test: `backend/tests/ui-app-settings.mjs` (Chrome check, same style as `ui-pages.mjs`)

**Interfaces:**
- Consumes: Task 2 HTTP API.
- Produces: the preload contract Task 5 implements:
  ```ts
  interface MuseHikDesktop {
    pickFolder(): Promise<string | null>;
    onUpdateReady(cb: (version: string) => void): void;
    restartToUpdate(): void;
    checkForUpdates(): Promise<{ status: 'latest' | 'downloading' | 'ready' | 'error'; version?: string; message?: string }>;
  }
  ```
- `AppSettingsService` (providedIn root): `info: Signal<AppInfo | null>`, `aiAllowed: Signal<boolean>` (`profile === 'poontje'`; `true` while loading is NOT allowed — default `false` until loaded so MuttMutt never sees a flash), `load()`, `setProfile(p)`, `pickFolder(): Promise<string|null>` (`desktop?.pickFolder()` else `POST /api/app/music-folder/pick`), `changeMusicDir(path, move)`.

- [ ] **Step 1: Write the UI check** `backend/tests/ui-app-settings.mjs`: opens Settings; checks sections "Who uses this laptop?" and "Music folder" exist; clicks MuttMutt → home has no "Instrumental separator" tile and navigating to `separate` shows home; clicks Poontje → tile is back; the music folder row shows the current path from `GET /api/app`; restores the original profile at the end. (Folder change itself is covered by Task 2 tests; the dialog cannot be driven from Chrome.)
- [ ] **Step 2: Run** it against `ng serve` + server — FAIL (sections missing).
- [ ] **Step 3: Implement.**
  - Settings, new first section **"Who uses this laptop?"**: radiogroup Poontje / MuttMutt (same markup as Theme), hint "MuttMutt hides the AI tools (instrumental separator)."
  - Section **"Music folder"**: label = path, hint = "N songs"; button "Change..."; after a pick, an inline confirm: "Move my N songs there" (primary), "Use this folder as it is", "Cancel"; result line: "Moved N songs." / "N songs could not be moved; they are still in <old>." / server error text.
  - Section **"About MuseHik"** only when `info.installed`: "Version x.y.z", button "Check for updates" showing the status text ("You have the latest version." / "Downloading version x.y.z..." / "Version x.y.z is ready, restart to install." / error message).
  - Home: separator tile inside `@if (app.aiAllowed())`. App: `@case ('separate')` renders the separator only if `aiAllowed()`, else `<app-home />`.
  - `UpdateBanner` in `app.html` above `<app-player-bar />`: hidden until `desktop?.onUpdateReady` fires; text "A new version of MuseHik is ready." + button "Restart now" → `desktop.restartToUpdate()`.
- [ ] **Step 4: Run** `cd frontend && npx ng build` (no errors) and the UI check — all PASS. Also re-run `node tests/ui-pages.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(frontend): profile switch, music folder setting, update banner`

---

### Task 5: Electron shell (`desktop/`), runnable unpackaged

**Files:**
- Create: `desktop/package.json` (name `musehik`, productName `MuseHik`, version `1.0.0`, `main: "main.mjs"`, scripts `start: electron .`, `test: node --test tests/`; devDeps `electron`, `electron-builder`; deps `electron-updater`)
- Create: `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/loading.html`, `desktop/layout.mjs`, `desktop/python.mjs`, `desktop/updates.mjs`
- Create: `desktop/tests/python.test.mjs`, `desktop/tests/layout.test.mjs`
- Modify: `.gitignore` (`desktop/stage/`, `desktop/dist/`)

**Interfaces:**
- Consumes: Task 3 IPC `'quit'`; Task 4 preload contract; Task 1/2 env vars.
- Produces:
  - `layout({ packaged: boolean, resourcesPath: string, repoRoot: string, appData: string, localAppData: string, music: string }): { node, backendDir, webRoot, pythonTemplate|null, env }` — packaged: `resources/{node/node.exe, backend, web, python}`, env sets `MUSEHIK_INSTALLED=1`, `MUSEHIK_DATA_DIR=<appData>\MuseHik`, `MUSEHIK_DEFAULT_MUSIC_DIR=<music>\MuseHik`, `CLOUD_CACHE_DIR=<localAppData>\MuseHik\cloudCache`, `MUSEHIK_WEB_ROOT`, `PYTHON_BIN`, `FFMPEG_BIN`, `PORT=38517`, `MUSEHIK_VERSION`. Unpackaged (dev): system `node` (`process.env.npm_node_execpath` or `node` on PATH), repo `backend/`, repo `frontend/dist/.../browser`, no Python env vars (backend defaults), `PORT=38517`, no `MUSEHIK_DATA_DIR` (uses `backend/data`).
  - `ensurePython(template: string, target: string): { copied: boolean }` — copies when `target/musehik-python.json` is missing or its `id` differs from the template's; otherwise does nothing.
  - `findFfmpeg(pythonRoot: string): string|null` — first `ffmpeg-*.exe` in `Lib/site-packages/imageio_ffmpeg/binaries`.

- [ ] **Step 1: Write the failing tests:**
  - `python.test.mjs`: `copies when nothing is there`; `does nothing when the id matches (a file added by pip survives)`; `replaces when the id changed`; `findFfmpeg finds the versioned exe`, `findFfmpeg returns null when missing`.
  - `layout.test.mjs`: `packaged layout points into resources and sets installed env`; `dev layout uses the repo and no data dir override`; both set `PORT` to `'38517'`.
- [ ] **Step 2: Run** `cd desktop && npm install && npm test` — FAIL.
- [ ] **Step 3: Implement.**
  - `main.mjs`: `app.requestSingleInstanceLock()` (second launch focuses the window); show a `BrowserWindow` (title MuseHik, bounds remembered in `userData/window.json`, menu bar hidden) on `loading.html` ("Starting MuseHik..." or, when `ensurePython` will copy, "Setting up MuseHik (first start only)..."); in packaged mode run `ensurePython` (async-friendly: copy with `fs.promises.cp`); spawn `node <backendDir>/server.mjs` with `stdio: ['ignore','pipe','pipe','ipc']`, `windowsHide: true`, cwd `backendDir`, env from `layout`; append stdout/stderr to `<localAppData>\MuseHik\logs\server.log` (dev: `desktop/server.log`); poll `GET http://127.0.0.1:38517/api/app` every 300 ms up to 60 s, then `loadURL`. If the child exits first or the timeout hits, load `loading.html?error=<text>` showing "MuseHik could not start" + last 20 log lines + the log path; if the log contains `EADDRINUSE`, the text is "MuseHik could not start: port 38517 is in use. Close the other MuseHik and try again."
  - Quit: on `before-quit`, `child.send('quit')`, wait for exit up to 5 s, else `taskkill /pid <pid> /T /F`.
  - `ipcMain.handle('pick-folder')` → `dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose the folder where MuseHik keeps your music' })`.
  - `updates.mjs` (packaged only): `autoUpdater.autoDownload = true`, `autoInstallOnAppQuit = true`; check on start and every 4 h; `update-downloaded` → `win.webContents.send('update-ready', version)`; `ipcMain.handle('check-updates')` returns the Task 4 status shape; `ipcMain.on('restart-to-update')` → `autoUpdater.quitAndInstall()` (after the backend quit sequence). Dev: `check-updates` returns `{ status: 'latest' }`.
  - `preload.cjs`: `contextBridge.exposeInMainWorld('musehik', {...})` matching the Task 4 interface.
- [ ] **Step 4: Run** `npm test` — PASS. Then `cd frontend && npx ng build && cd ../desktop && npm start`: the window opens on the app, Settings shows the sections, "Change..." opens the native picker, closing the window leaves no `node.exe` from `backend/server.mjs` running (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'server.mjs'` is empty). Start a download, close the window mid-download, same check plus no `python.exe`/`ffmpeg.exe` children.
- [ ] **Step 5: Commit** `feat(desktop): Electron shell starts the backend in its own window`

---

### Task 6: Installer: stage Python, node.exe, backend, web; icon; build and install locally

**Files:**
- Create: `desktop/scripts/stage.mjs`, `desktop/build/icon.png` (512×512, from `desktop/build/icon.svg`: a white music note on the app's accent colour, rounded square)
- Modify: `desktop/package.json` (`build` section, script `dist: node scripts/stage.mjs && electron-builder --win --publish never`)

**Interfaces:**
- Consumes: Task 5 packaged layout (`resources/{node,backend,web,python}`).
- Produces: `desktop/stage/{node/node.exe, backend/, web/, python/}` and `desktop/dist/MuseHik-Setup-<version>.exe` + `latest.yml`.

- [ ] **Step 1: Implement `stage.mjs`** (constants at the top, pinned, looked up once while implementing: the python-build-standalone release tag + `cpython-3.12.*-x86_64-pc-windows-msvc-install_only.tar.gz` URL and its SHA-256 from the release's `SHA256SUMS`; Node 24 LTS `node-v24.*-win-x64.zip` URL + SHA-256 from `SHASUMS256.txt`). Steps: download to `desktop/stage/cache/` (skip if present and hash matches; abort on mismatch), extract with Windows `tar -xf`, copy `node.exe` only; run `<python>/python.exe -m pip install -r backend/requirements.txt`; write `python/musehik-python.json` `{ id: sha256(python URL + requirements.txt content) }`; copy `backend/` without `tests/ data/ .venv/ node_modules/ config.json` then `npm ci --omit=dev` in the copy; copy `frontend/dist/musehik-frontend/browser` to `web/` (run `npx ng build` first if `frontend/dist` is older than `frontend/src`, same check as `launch.mjs`).
- [ ] **Step 2: Configure electron-builder** in `desktop/package.json`: `appId: "com.tylerbvt.musehik"`, `productName: "MuseHik"`, `directories.output: "dist"`, `files: ["main.mjs","preload.cjs","loading.html","layout.mjs","python.mjs","updates.mjs","package.json"]`, `extraResources: [{from:"stage/node",to:"node"},{from:"stage/backend",to:"backend"},{from:"stage/web",to:"web"},{from:"stage/python",to:"python"}]`, `win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "build/icon.png" }`, `nsis: { oneClick: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: "MuseHik", artifactName: "MuseHik-Setup-${version}.${ext}" }`, `publish: [{ provider: "github", owner: "tylerBVT", repo: "MuseHik" }]`.
- [ ] **Step 3: Make the icon** (`icon.svg` → `icon.png` with headless Edge `--screenshot --window-size=512,512`).
- [ ] **Step 4: Build** `cd desktop && npm run dist` — expect `dist/MuseHik-Setup-1.0.0.exe` (report its size).
- [ ] **Step 5: Install and smoke-test** on this laptop: run the installer; "MuseHik" appears in Windows search and on the desktop; it opens in its own window; `%APPDATA%\MuseHik\app-settings.json` and `%LOCALAPPDATA%\MuseHik\python\` exist after first start; Settings shows profile **Poontje** (separator installed here), version 1.0.0, About section; download one YouTube song into the default `Music\MuseHik` and play it; in Task Manager, yt-dlp ran with the bundled `node.exe` (`resources\node\node.exe`) — check `server.log`. Then uninstall from Windows Settings: app gone, `%APPDATA%\MuseHik` and the music remain.
- [ ] **Step 6: Commit** `feat(desktop): installer with bundled Python, yt-dlp, ffmpeg and node`

---

### Task 7: Releases: GitHub Actions, release command, docs

**Files:**
- Create: `.github/workflows/release.yml`, `desktop/scripts/release.mjs`
- Modify: `README.md` (Run it: "Installed app" + "Release a new version"), `docs/ROADMAP.md` section 2 (decision: Electron, done)

**Interfaces:**
- Consumes: Task 6 `npm run dist` pieces.
- Produces: `cd desktop && npm run release [patch|minor|major]` (default `patch`).

- [ ] **Step 1: Write `release.yml`**: on `push: tags: ['v*']`; `permissions: contents: write`; `runs-on: windows-latest`; steps: checkout, `actions/setup-node` Node 24, `npm ci` in `frontend` + `npx ng build`, `npm ci` in `desktop`, `node scripts/stage.mjs`, check the tag equals `v` + `desktop/package.json` version (fail otherwise), `npx electron-builder --win --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- [ ] **Step 2: Write `release.mjs`**: refuse if the working tree is dirty or the branch is not `main`; run `npm test` in `backend/` and `desktop/` (stop on failure); bump `desktop/package.json` version; commit `release: vX.Y.Z`; tag `vX.Y.Z`; `git push origin main --follow-tags`; print the Actions URL.
- [ ] **Step 3: Docs** in README: how mum installs (link to the latest release's `MuseHik-Setup-x.y.z.exe`, "More info > Run anyway" once), how to release (`npm run release`), where installed data lives.
- [ ] **Step 4: Verify** the workflow file parses (`npx --yes action-validator .github/workflows/release.yml` or push to the branch and check Actions shows no syntax error); the first real release happens after merge, run by the author.
- [ ] **Step 5: Commit** `feat: release workflow and release command`

## Left for after merge (author)

- Run `npm run release` on `main` for v1.0.1, watch the Action publish it, and confirm the v1.0.0 install from Task 6 shows the update banner.
- Final test of the risky bit on a Windows account without Node/Python (a new local user on this laptop is enough), before sending the link to her.
