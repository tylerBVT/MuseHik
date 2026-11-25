# Laptops use the music API instead of FTP: design

Date: 2026-11-24. Status: asked for by the owner ("everything that worked with FTP must work through the PHP API;
take initiative and decide"). Builds on `2026-11-24-music-api-design.md`.

## Why

One way into the cloud for every device. The phone can only use the HTTPS API; the laptops used FTP with the
hosting password (sent unencrypted: the hosting only does plain FTP). Moving the laptops to the API removes the
password from the laptops, encrypts the traffic, and lets the server decide conflicts (playlist sync) under a lock.

## Goals

- Every cloud feature of the PC app works through the API, unchanged for the person using it: Cloud page (list,
  play with seeking while it downloads, cache, prefetch, cover from the local copy, rename, delete, songs added by
  hand), Cloud upload (library songs and any folder, progress, stop, skip duplicates, storage cap), Download to cloud,
  Download from cloud (save to the laptop), shared playlists (both ways, deletes), storage bar, Offline switch,
  last-known list when the cloud cannot be reached, Test connection.
- No FTP code left in the app: `remote.mjs`, `connections.mjs`, `basic-ftp`, `ftp-srv`, the FTP test fixture go
  (git keeps them).

## Non-goals

- Deploying to LWS (next step, separate).
- Publishing a new app version (the owner decides when).

## Decisions (all mine, as asked)

1. **The laptop's server becomes an API client.** Its `/api/cloud/*` routes, jobs and cache stay; only the transport
   changes. The PC screens need no change except Settings.
2. **What the API gains** (so the laptops lose nothing):
   - `GET /status` → `{ storedBytes, storageLimitBytes, songs }` (storage bar; also "Test connection").
   - `GET /songs` first brings the index in line with `songs/` (the laptops' `syncFolder`, moved to the server:
     audio files added by hand join as "added by hand", entries whose file is gone leave; an empty folder changes
     nothing) and answers `{ songs, synced: { added, removed } }`.
   - `POST /songs` also takes `isrc`. `PATCH /songs/{id}` also takes `album`, `duration`, `isrc` (the laptop fills
     in a hand-added song's tags once it has the file).
   - `GET /playlists?raw=1` → the stored entries as they are, deleted markers included (`uid`, not `id`).
   - `PUT /playlists/{uid}` with a whole entry `{ name, owner, updatedAt, songs }` or `{ deleted: true, updatedAt }`:
     stored only if newer than what the server has ("last change wins", decided under the lock). Answers
     `{ applied, playlist }`. The laptop's sync logic stays; it sends each change instead of rewriting the file.
3. **Settings** become `{ url, key, name, cacheLimitGB, online }`. The key never reaches the page (`hasKey`). The
   storage cap now lives on the server (`config.php`), shown by the storage bar. Old FTP fields in a saved file are
   ignored: each laptop enters the address and key once.
4. **Uploads** use `node:http(s)` with an exact `Content-Length` (some PHP setups refuse chunked uploads), counting
   bytes for the progress bar; stopping aborts the request (PHP drops the partial file itself). Duplicate → 409 →
   "skipped"; cloud full → 413 "Not enough cloud storage" → the rest of the job fails with that reason, as before.
5. **Downloads** (play-while-downloading cache, save to laptop) use `fetch` streaming; the size comes from
   `Content-Length`.
6. **Errors** read as before: "Cloud: <reason>" (wrong key, cannot reach the address, server message).
7. **Coexistence**: the API writes exactly what FTP wrote, so a laptop not yet updated keeps working on FTP next to
   an updated one. No day where both must switch.

## Tests

`tests/cloud-fixture.mjs` `startCloud()` runs `php -S` on a temporary cloud folder behind a small Node proxy that
counts requests and song downloads and can slow a song down (what the FTP fixture offered:
`logins` → `requests`, `reads`, `slow`). Every existing cloud test moves to it (FTP-only tests about connections are
deleted with the code they tested). `music-api.test.mjs` uses the laptops' new client for the "laptop" side. The
cloud tests need PHP (as the API tests do); `music-api.test.mjs` skips without it.
