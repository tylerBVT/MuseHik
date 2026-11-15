# MuseHik – Personal Music Player

> Status: **PLANNING. No code yet.** Waiting for the owner's approval of the tech stack (section 5) before implementation starts.

## 1. Goal

A personal music player, inspired by Spotify/Deezer but much simpler, that runs on **PC (Windows) and Android**.
One shared codebase as much as possible; two releases on GitHub (a desktop installer and an Android APK).

Priority: a working, maintainable MVP over fancy features. Build incrementally and wait for approval before each milestone.

## 2. MVP scope

- Register/import MP3 files; scan a chosen music folder.
- Show title, artist, album, duration, artwork.
- Browse and search the library.
- Play, pause, previous, next, seek, volume.
- Playlists (they reference tracks by ID, never copy audio files).
- Show the currently playing track.

## 3. Storage design

Metadata and audio are stored separately.

- **Metadata + playlists:** SQLite. Track fields: `id, title, artist, album, duration, artwork_path, storage_provider, file_location, added_at`. Playlist: `id, name, created_at`. PlaylistTrack: `playlist_id, track_id, position`.
- **Track IDs** are stable and independent of where the file lives.
- **Audio providers** (modular, behind one interface):
  - `local`: files on the device.
  - `remote-https`: read-only, streamed over HTTPS with HTTP Range requests (no full download needed).
  - Future (NOT now): LWS/OVH, Cloudflare R2, Google Drive, other object storage.

### Remote hosting (LWS Perso, mother's subscription)

- **Do not assume it can be used for streaming.** LWS has a 25 GB/month "optimal" traffic threshold (shared with her website, throttling beyond it) and specific restrictions on binary/MP3 downloads. **Must be confirmed with LWS before relying on it.**
- Development uses a local mock HTTP server with test files. The app must never depend on LWS.

## 4. Out of scope for now (do not implement without approval)

Multiple remote providers, cloud sync, multi-device, accounts/auth, offline caching, music discovery, automated music acquisition.

## 5. Technology analysis and recommendation

### 5.1 Is a Python/Java backend a good idea? -> No

The brief says to avoid a separate backend unless it clearly helps, and here it would actively hurt:

- A Python or Java server does **not run inside an Android app** in any simple way. You would have to host it somewhere, which defeats a personal offline-capable player.
- Everything the app needs (read files, read tags, SQLite, HTTPS range requests, audio playback) can run **on the device**.
- So: **no backend.** All logic lives in the app (TypeScript, plus a thin native layer per platform).
- Mutagen (Python) is therefore not a good fit either. Use a JS/TS tag reader such as `music-metadata` (works in browser/WebView), or Rust `lofty` if we go through Tauri.

### 5.2 Angular?

Fine, and a reasonable choice. Angular, React and Vue all work with both Tauri and Capacitor. The earlier brief suggested React; Angular is OK if you prefer it or already know it. It is heavier and more verbose than React, but its structure (services, dependency injection) suits the "swap storage providers behind an interface" design very well.

### 5.3 Tauri vs Capacitor, and Ionic

- **Ionic is not a competitor to either.** Ionic = a UI component library/framework. **Capacitor** is the native runtime (made by the Ionic team) and can be used **without** Ionic UI. You don't need Ionic. Plain Angular + your own CSS (or Angular Material) is enough.
- **Tauri 2**: small, fast desktop apps (Rust backend + system WebView). Tauri 2 also supports Android, but mobile support is younger: fewer plugins, rougher tooling, and **background audio on Android** (keep playing with the screen off, notification/lock-screen controls) is not turnkey.
- **Capacitor**: mature Android story, large plugin ecosystem (filesystem, SQLite via community plugin, etc.). Desktop is not its strength (Electron-based community option exists).

### 5.3.1 Android-specific risk worth knowing early

A music player is only useful if audio keeps playing when the screen is off or the app is in the background. On Android this requires a **foreground service + MediaSession** (notification controls). Plain HTML `<audio>` in a WebView can be killed or paused by Android. This will probably need a native plugin. It's the biggest technical risk of the mobile version, in either Tauri or Capacitor.

### 5.4 Options

| | A. Angular + Tauri 2 (desktop **and** Android) | B. Angular shared core, Tauri (desktop) + Capacitor (Android) | C. Capacitor only (Android) + Electron for desktop |
|---|---|---|---|
| Shared code | Highest (one runtime) | High (UI + logic shared; thin per-platform adapters) | High |
| Android maturity | Lower | Higher | Higher |
| Desktop size/perf | Best | Best | Heavier (Electron) |
| Native glue | One (Rust) | Two (Rust + Capacitor plugins) | Two |
| Risk | Android background audio, plugin gaps | Maintaining two thin adapter layers | Large desktop bundle |

### 5.5 Recommendation (pending approval)

**Option B**: one **Angular + TypeScript** app containing the UI, player logic, library logic, and storage-provider interfaces. Per-platform differences hidden behind small adapters (file access, SQLite, background-playback glue):

- **Desktop (Windows):** Tauri 2.
- **Android:** Capacitor.
- **Database:** SQLite on both (Tauri SQL plugin / Capacitor SQLite plugin) behind a single repository interface.
- **Playback:** HTML Audio API first; add native media-session/background playback on Android.
- **Remote:** `fetch`/`<audio src>` over HTTPS with Range support.
- **Tags:** `music-metadata` (TypeScript).

Why not Option A? It would be simplest on paper (single runtime), but Android in Tauri is the riskier piece for a music app. A fallback plan: start with Tauri for both and switch the Android side to Capacitor if background audio proves painful. Because the Angular code is shared, that switch is cheap.

## 6. Proposed repository structure

```text
MuseHik/
├── README.md
├── docs/                    # architecture notes, LWS findings
├── app/                     # shared Angular app (UI + logic)
│   └── src/
│       ├── core/            # models, player service, library service
│       ├── storage/         # StorageProvider interface + local / remote-https
│       ├── data/            # repository interface (SQLite adapters per platform)
│       ├── platform/        # adapters: file system, background playback
│       └── ui/              # components: library, player bar, playlists
├── desktop/                 # Tauri shell
├── android/                 # Capacitor shell
├── mock-server/             # local HTTPS/HTTP server with Range support + test MP3s
└── .github/workflows/       # build desktop + APK releases
```

## 7. Components and communication

```text
UI components -> Player service (HTML Audio) -> StorageProvider.getPlayableUrl(track)
              -> Library service -> Repository (SQLite) + Tag reader
                                 -> Folder scanner (platform adapter)
```

The player only asks a provider for a playable URL/stream; it never knows whether the file is local or remote.

## 8. Technical risks

1. Android background playback and notification controls (see 5.3.1).
2. Android file access: scoped storage/permissions for scanning a music folder.
3. Remote streaming: server must support HTTP Range for seeking; handling buffering and network drops.
4. LWS may forbid or throttle MP3 serving (needs confirmation).
5. SQLite plugins differ per platform (hidden behind one interface).
6. Large libraries: scanning speed and search performance.

## 9. Phased plan (each phase needs approval)

1. Scaffold the project, confirm stack, set up the mock server.
2. Basic player (play/pause/seek/volume/next/prev) with test files.
3. Local import + library browse/search.
4. SQLite persistence + playlists.
5. Remote read-only HTTPS provider.
6. Test seeking, buffering, network interruptions.
7. Android build + background playback; GitHub release pipeline (desktop + APK).
8. Evaluate LWS (after contacting them).

## 10. Open questions for the owner

1. Approve **Option B** (Angular + Tauri desktop + Capacitor Android), or prefer A (Tauri everywhere) or another?
2. **Angular** confirmed, or React as in the original brief?
3. OK to drop Python/Java and any backend, keeping everything on-device?
4. Desktop target: Windows only, or also macOS/Linux?
5. Is Android background playback (screen off) a must-have for the first mobile release?
6. Do you have an Android device or emulator for testing, and is Android Studio installed?
7. Do you already have Node.js, Rust, and the Android SDK installed?
