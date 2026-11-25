# MuseHik roadmap (discussion notes, nothing here is built yet)

App for two users (the author and their mother). Everything local first; remote and mobile come later.

## 1. Where user data lives (profiles, playlists)

Today playlists live in the server's SQLite file (`backend/data/library.db`, git-ignored), which is already "local file".
Decision for now: **no accounts, no login.** Local only.

Keep two things apart, because every later step (LWS, phone) depends on it:

| | What | Where |
|---|---|---|
| Music | the audio files | the music folder (later: LWS / phone storage) |
| User data | playlists, theme, favourites, history | one small store per profile |

Ideas, from simple to heavier:
1. **One profile per laptop** (fits "me and my mum" if we each have our own laptop). Nothing to build.
2. **Several profiles on one laptop**, Netflix style: pick a name at start, no password. A profile = its own data folder or DB for playlists/settings; the music library stays shared.
3. **Real accounts** (login, server keeps all profiles): only worth it once a remote server exists. Then a simple login (user + password, token) on that server. Not needed before.

Weakness to fix first (before any sync or move to another device):
- Playlists currently point at songs by the library's **numeric id**. If a file is deleted and downloaded again, it gets a new id and silently drops out of the playlist; ids also differ between laptop, LWS and phone.
- **Done 2026-11-21** (shared playlists): playlists now store songs by identity.
- Fix: reference songs by a **stable key** (ISRC, else source id like `youtube:xxx`, else cleaned artist+title+duration, the same key the duplicate check already uses). Then playlists survive rescans and can move between devices.
- Add **export / import of user data as one JSON file** (backup, and the easiest "sync" for now).

## 2. Mum can just double-click it (needed before anything else is useful to her)

**Done 2026-11-23: Electron app** (`desktop/`), NSIS installer with Node, a signed python.org Python, yt-dlp and ffmpeg inside, updates from GitHub Releases. Design: `docs/superpowers/specs/2026-11-23-desktop-app-design.md`.

## 3. Remote library on the LWS server (stream over wifi, nothing stored on the laptop)

**2026-11-24: the laptops use it too** (no more FTP; `docs/superpowers/specs/2026-11-24-cloud-over-api-design.md`).
**2026-11-24: the phone's API exists** (`music-api/`, PHP, tested locally against the laptops' own code; design:
`docs/superpowers/specs/2026-11-24-music-api-design.md`). Phone ↔ laptop transfers go through the cloud (phone →
cloud → laptop and back), no direct link.
**2026-11-24: live on LWS** at https://www.waixera.com/music-api (`node music-api/deploy.mjs`, skill
`deploy-music-api`). LWS's edge cache is in front of it: every answer says `Cache-Control: private, no-store`.
**2026-11-24: the phone has the full cloud** (plan: `docs/superpowers/plans/2026-11-24-phone-cloud.md`): list and play
cloud songs, rename, delete, upload files from the phone (tags read on the phone), save songs on the phone for
offline play ("All tracks" on the phone = songs saved on it), shared playlists (all phone playlists are on the
cloud), storage bar, Online/Offline. It talks to the API directly (`features/cloud/music-api.ts`). Not on the
phone: the YouTube downloader and the separator; covers (the API has no cover endpoint yet).

To confirm with LWS **before** designing (from the project brief): is streaming audio allowed on that hosting plan, how much storage, and can it run Node at all? (Bandwidth: unlimited, confirmed 2026-11-24.) Classic shared hosting often only runs PHP; if so we need either a PHP port of the small API or a cheap VPS.

Design that keeps the app independent of LWS:
- The player only needs a "library source": list songs, stream URL (HTTP Range), cover. The local server already has exactly this API, so a remote server is the **same API on another address**. A setting chooses local folder or remote server.
- The remote needs authentication (token or login) and HTTPS, since it holds personal music.
- Upload feature: laptop sends files to the remote server; the remote keeps its own index.
- Honest caveat: putting downloaded copyrighted music on a hosting server is a step beyond a private local copy (host terms of service, takedown risk). Keep it private (login required, no public links), personal use only, and check the host's rules.

## 4. Phone (Android first)

Technology: wrap the existing Angular app with **Capacitor**. Most UI and logic is reused; native parts are added as plugins.

Native work that does not exist in the web app:
- **Playback runs in Android, not in the WebView** (done 2026-11-24): `MusicService.java` (Media3, a
  MediaSessionService) plays the songs; the web player drives it through `NativePlayerPlugin.java` /
  `core/native-audio.ts` and hands it the whole play order, so it moves on by itself. Checked on the Galaxy A16:
  - the music goes on with the screen off and after the app is swiped away from the recent apps (like Deezer); opened
    again, the app shows what plays and controls it;
  - notification / lock screen / headset buttons (previous, play-pause, next);
  - a call or the assistant pauses it and it plays on afterwards (Media3's audio focus); another music app stops it;
  - unplugged headphones pause it (Media3; cannot be faked over USB, check by hand).
  Why not the WebView: swiping the app away destroys its screen and the WebView with it (Capacitor destroys it).
  LWS's edge cache hides file sizes and ignores "from byte N" ranges: the player assumes a constant bitrate to seek.
- **Back button** (done 2026-11-24, `core/back-button.ts`): closes an open menu, then goes back a page; on the home
  page it sends the app to the background (the music goes on) instead of closing it.
- **Songs on the phone live in its Music folder** (done 2026-11-24, `MusicFolderPlugin.java`, Android's MediaStore):
  cloud songs saved on the phone go to `Music/MuseHik/Artist - Title.mp3` (seen from a computer over the cable), and
  every song copied into `Music` by cable shows in All tracks and plays (one "music and audio" permission). Songs
  saved by older versions moved there by themselves. Not done yet: a song copied by cable that is also on the cloud
  is not recognised as the same song (match by title and artist?); the app cannot rename or delete songs copied by
  cable (Android asks for a confirmation per file: possible later). Still to do: free-space handling.
- A mobile layout (the player bar already has a narrow layout; pages need a pass).

Getting music onto the phone:
- Important correction to the worry "mobile can't download": what is hard on a phone is downloading **from YouTube** (yt-dlp, store rules). Downloading **from our own server** is just HTTP files, which is easy.
- So the simplest transfer is **wifi sync**: the phone app connects to the laptop (same network) or the LWS server and downloads chosen songs/playlists for offline use. Same code serves both.
- **Cable transfer** is possible but fiddly (Windows sees the phone as MTP, apps cannot write freely to other apps' folders on Android). Option for later: drag files into a folder the app scans, or use ADB. Worth doing only if wifi sync turns out insufficient.
- Distribution without the Play Store is fine for two users (install the APK directly).

## Suggested order

1. **Now / next**: stable song keys for playlists, JSON backup/restore, persist shuffle/repeat, "retry failed" in downloads, decide MP3 vs M4A, remaining playlist download tests (Spotify, YouTube).
2. **Packaging** for the laptop so mum can launch it with one click.
3. **Remote server** (after asking LWS): auth, upload, streaming, settings switch local/remote.
4. **Android app** with Capacitor: background playback and call handling first, then offline sync.
5. **Cable transfer**, only if still wanted.

## Decisions after discussion 2

- **Two users, one laptop each.** Both download. Each has their own local storage and playlists; the remote storage is shared (each can see, play and delete what the other uploaded).
- **Laptops: one Windows installer, no Docker.** Docker Desktop on a non-technical user's laptop (WSL, admin rights) is the opposite of "double-click, no error". Use a normal installer (Electron or Tauri, built with an installer tool) that bundles: the built Angular app, the Node server, yt-dlp and ffmpeg. Things to solve: the Node runtime that yt-dlp needs for YouTube challenges, an unsigned installer triggers a Windows SmartScreen warning ("More info > Run anyway"), and **yt-dlp breaks every few weeks when YouTube changes, so the app needs an automatic yt-dlp update**.
- **Docker is only for the server side**, and only if we ever use a VPS. An image cannot run on a classic shared plan.
- **Remote server = metadata DB + files + a small API**, not "just a database": audio files live on the disk (100 GB plan), the DB (MySQL, or an SQLite file to keep her single MySQL DB free) only holds titles, owners, sizes. The local Node server's API (list, stream with Range, cover, upload, delete, quota) is the contract; the remote is a second implementation of it. Preferred remote: **PHP** (always available on shared hosting) with files served by Apache; Node on her plan is unconfirmed.
- **Quotas, enforced on the server (not only in the app):**
  - storage cap for the app (suggestion: 30 GB, about 6000 songs; she decides), per-user usage tracked;
  - before every upload the app asks the server for the remaining quota and refuses if the file does not fit; before every download to a laptop it checks local free disk space.
  - Bandwidth is **unlimited** on her plan (confirmed 2026-11-24): no monthly cap. Devices still keep a **local cache** so songs play offline and start fast.
- **Open check on her hosting plan:** whether her plan has "Setup Node.js App" in cPanel or SSH, and what "1 Go" in the offer means. LWS's own terms on hosting large audio files have to be read or asked to support.

## Open questions

- What are the exact numbers on her LWS offer page (screenshot)?
- Storage cap for the app?
- Who may delete a song on the shared remote: only its uploader, or both?
