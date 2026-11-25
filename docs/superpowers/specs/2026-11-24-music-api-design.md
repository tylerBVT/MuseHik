# Music API (PHP on LWS): design

Date: 2026-11-24. Status: approved in conversation (the owner's prompt + five changes, all five taken).

## Why

The phone app (Capacitor, `frontend/android/`) cannot use the cloud the way the laptops do: the laptops talk FTP
with the hosting password, which a phone WebView cannot do and should not hold. The phone needs an HTTPS API on the
LWS shared hosting (Apache + PHP only, no long-running processes). It is also the way phone ↔ laptop transfers will
work: phone → cloud → laptop and back (no direct phone-laptop link). Bandwidth on the plan is unlimited.

It is written and tested on the laptop first (PHP's built-in server), then deployed to LWS unchanged; only the config
differs.

## Goals

- A PHP API in `music-api/` (repo root), deployed to LWS as `public_html/music-api/` (exact place: step 2).
- It works on **the same cloud folder the laptops already fill over FTP**: `library.json`, `playlists.json`,
  `songs/`. Phone and laptops see one library and one set of shared playlists.
- Endpoints: list / stream (HTTP Range) / upload / rename / delete songs; list / create / update / delete playlists.
- Step 1 (this work): runs locally, fully tested, then stop for the owner to check.
- Step 2 (later, separate): deployment to LWS.

## Non-goals (for now)

- Covers (they are inside the audio files; reading them in PHP is later work).
- The phone screens that use the API (next piece of work).
- Laptops switching from FTP to this API (the long-term fix for write races, see Constraints).
- Composer, a framework, MySQL. The storage layer is a small set of functions so MySQL could replace the JSON later.

## Anti-goals

- A second library: the API must never keep its own song list or playlist file.
- Songs or data reachable by URL without the key.
- Breaking the laptops: every file the API writes must read exactly as if a laptop wrote it.

## The files (contract with the laptops, see `backend/modules/cloud/store.mjs` and `playlistSync.mjs`)

`library.json`: `{ version: 1, nextId, songs: [ { id, file, title, artist, album, duration, isrc, key, size,
addedBy, addedAt, genre? } ] }`. `file` is a name inside `songs/`. New id = `nextId`, then
`nextId = max(nextId, id) + 1`. Unknown fields are kept untouched.

`playlists.json`: `{ version: 1, playlists: [ { uid, name, owner, updatedAt, songs: [ { title, artist, album,
duration, isrc, key } ] } | { uid, deleted: true, updatedAt } ] }`. `updatedAt` is milliseconds since 1970. The
laptops sync with "last change wins" per uid, so every change made by the API sets `updatedAt` to now; a delete writes
the `{ uid, deleted: true, updatedAt }` marker so the laptops drop their copy.

`songs/`: audio files named `Artist - Title.ext` (`fileBase` + `safeName` in `backend/core/lib.mjs`), with
` (2)`, ` (3)`... when taken. Files named `*.part.*` are unfinished uploads and ignored by everyone.

Rules ported exactly from `backend/core/lib.mjs` (same results for the same input; a shared list of examples checks
it): `safeName`, `fileBase`, `trackKey` (lowercase, accents removed, words `[a-z0-9]+`, primary artist only, "feat."
dropped), `sameIdentity` (same ISRC, or same key and lengths within 6 s; unknown length never blocks).

## Endpoints

All JSON (`{ "error": "..." }` on failure) with real status codes (400, 401, 404, 405, 409, 413, 415, 500).
Every request needs the key: header `X-API-Key`, or `?key=` (needed for `/songs/{id}/file`, because an `<audio>`
element cannot send headers; HTTPS on LWS keeps it private). Compared with `hash_equals`.

| Method | Path | What |
|---|---|---|
| GET | `/songs` | `{ songs: [...] }` the index entries |
| GET, HEAD | `/songs/{id}/file` | the audio, `Accept-Ranges: bytes`, `206` + `Content-Range` for one range, right `Content-Type` |
| POST | `/songs` | multipart `file` (+ optional `title`, `artist`, `album`, `duration`, `addedBy`). Allowed: `.mp3 .m4a .opus .ogg .flac .wav`; size ≤ `maxUploadMB`; total ≤ `storageLimitGB`. Title/artist default to the file name `Artist - Title`. Same song already there (sameIdentity) → `409` with that song. Written as `*.part.*`, then renamed. `addedBy` defaults to config `defaultAddedBy` ("phone"). → `201` the new entry |
| PATCH | `/songs/{id}` | `{ title?, artist?, genre? }`, same rules as the laptop's `editSong` (title required, ≤200/200/60 chars; title/artist change renames the file `Artist - Title.ext`, never over another file; key recomputed). Shared playlists that held the old song get its new title/artist/key and a new `updatedAt` (like `renameSongEverywhere`) |
| DELETE | `/songs/{id}` | removes the file and the entry (playlists keep it, shown "not available", as the laptops do) → `204` |
| GET | `/playlists` | `{ playlists: [ { id: uid, name, owner, updatedAt, songs: [ {..., songId} ] } ] }`; deleted markers hidden; `songId` = the matching cloud song's id (sameIdentity) or null |
| POST | `/playlists` | `{ name, owner?, songs? }` → new uid (UUID v4), `201` |
| PATCH | `/playlists/{uid}` | `{ name?, songs? }` |
| DELETE | `/playlists/{uid}` | writes the deleted marker → `204` |

`songs` in a playlist body: a list of `{ id }` (a cloud song, copied as `{ title, artist, album, duration, isrc,
key }`) or full `{ title, artist, ... }` entries (kept as they are, so songs not on the cloud survive an edit).
Names: 1–100 characters after trimming.

## Structure

- `music-api/index.php`: the router (config, key check, CORS, JSON output, errors), then one handler per action.
- `music-api/lib/`: `http.php` (JSON, errors, CORS, Range), `store.php` (read/write the two JSON files under a lock),
  `rules.php` (the ported lib.mjs rules), `songs.php`, `playlists.php`.
- `music-api/.htaccess`: everything → `index.php`; deny `lib/`, `config*.php`, dot files.
- `music-api/router.php`: for `php -S` locally (same routing without Apache).
- `music-api/config.example.php` in git; `music-api/config.php` git-ignored. Keys: `dataDir` (the cloud folder),
  `apiKey`, `maxUploadMB`, `storageLimitGB`, `defaultAddedBy`, `allowedOrigins`.

## Constraints and decisions

- **PHP 8.1+**, extensions: `json`, `mbstring` (checked at start, clear error). `intl` is used when present for
  accent removal, with a fallback so results match without it (tested both ways).
- **CORS**: the app runs in the phone at `https://localhost`; `X-API-Key` makes the WebView send a preflight.
  `OPTIONS` → `204` with `Access-Control-Allow-Origin` (origins from config; default `https://localhost`,
  `http://localhost`, `capacitor://localhost`, `http://localhost:4200`), `-Headers: X-API-Key, Content-Type, Range`,
  `-Methods`, `-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`.
- **Writes**: read-modify-write of a JSON file holds an exclusive `flock` on `<dataDir>/.music-api.lock` (protects
  against other PHP requests) and writes a temp file then renames it (a laptop reading over FTP never sees half a
  file). The laptops write over FTP without locks, but they re-read just before writing, so a clash needs two writes
  in the same instant; the same risk already exists between the two laptops. Accepted; the real fix is the laptops
  using this API later.
- **Privacy**: the cloud folder must not be reachable by URL. Locally it is outside `music-api/`. On LWS: outside the
  web root, or a deny-all `.htaccess` in it (checked in step 2).
- **Local test** (`php -S 0.0.0.0:8000`): listens on the wifi so the phone can reach it later; the test folder is
  filled through the laptops' real code (the Node cloud store over the test FTP server from
  `backend/tests/ftp-fixture.mjs`), so its files are in exactly the laptops' format.

## Tests (step 1)

`backend/tests/music-api.test.mjs` (`node --test`, part of `npm test` when PHP is found, skipped otherwise):
starts the FTP fixture and `php -S` on the same temporary folder, then:
- the laptops' code writes songs + a shared playlist → the API lists and streams them (full and Range, 206/416);
- every endpoint, its errors and its status codes; a missing/wrong key → 401; path tricks (`../`, `%2e%2e`) → 404/400;
- API writes (upload, rename, delete, playlists) → the laptops' code reads them back correctly (index, playlist sync);
- the CORS preflight;
- the ported rules give the same output as `lib.mjs` on a list of examples (with and without `intl`).

A dev script starts FTP + PHP on a persistent local folder (`MuseHikData\music-api-dev\`), seeds a few songs from the
library, and prints the address and key, plus a list of curl commands for trying each endpoint by hand.

## Left to the builder

File layout inside `lib/`, exact error wording, how the dev script picks the seed songs, MIME table.
