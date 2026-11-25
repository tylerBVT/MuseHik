# Laptops on the music API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The laptop server talks to the PHP music API instead of FTP, for every cloud feature, and the FTP code is removed.

**Architecture:** PHP API gains status, folder sync, extra song fields, raw playlist read and last-change-wins playlist upsert. On the laptop, `modules/cloud/api.mjs` (HTTP client) replaces `remote.mjs` + `connections.mjs`; `store.mjs` `withCloud` keeps its shape (`cloud.index()`, `editSong`, `updateSong`, `removeSong`) plus `upload`, `download`, `playlists`, `putPlaylist`, `status`.

**Tech Stack:** PHP 8.1+, Node 26 (`fetch`, `node:http(s)`), Angular.

**Spec:** `docs/superpowers/specs/2026-11-24-cloud-over-api-design.md`

## Global Constraints

- PHP 8.1 syntax; tests on PHP 8.1 (`MuseHikData\php-8.1`).
- Error text for the page keeps the "Cloud: " prefix inside the backend.
- Settings fields: `url`, `key`, `name` (≤ 40), `cacheLimitGB` (> 0), `online`. Page sees `hasKey`, never `key`.
- `addedBy` for laptop uploads: `os.hostname()` (as before).

## Review Focus

- An address typed with a trailing slash or without `https://` → still works (`https://` added when no scheme).
- The key wrong or the address unreachable → "Cloud: wrong key" / "Cloud: cannot reach <host>", never a stack trace.
- A song renamed on the cloud while cached on the laptop → still plays from the cache (cache keyed by id).
- Stopping an upload halfway → no file and no entry on the cloud.
- A laptop still on FTP writing at the same time → the API reads its files unchanged (same format).

---

### Task 1: API additions
**Files:** `music-api/lib/{songs,playlists}.php`, `music-api/index.php`; tests in `backend/tests/music-api.test.mjs`.
- [ ] Tests: `GET /status`; `GET /songs` adds a hand-added file (title/artist from name, `addedBy` "added by hand", size, `addedAt` from the file date) and drops an entry whose file is gone, reports `synced`; empty folder → no change; `.part.` files ignored; `PATCH` with album/duration/isrc; `POST` with isrc; `GET /playlists?raw=1` shows deleted markers; `PUT` newer → applied, older/equal → not applied with the stored entry; `PUT` deleted marker; bad body → 400.
- [ ] Implement; run `node --test tests/music-api.test.mjs` → pass.

### Task 2: Laptop client + fixture + all cloud tests
**Files:** create `backend/modules/cloud/api.mjs`, `backend/tests/cloud-fixture.mjs`; rewrite `settings.mjs`, `store.mjs`, `upload.mjs`, `save.mjs`, `cache.mjs`, `playlistSync.mjs`, `routes.mjs`, `limits.mjs`; modify `server.mjs`, `modules/musicDownloader/jobs.mjs`; delete `remote.mjs`, `connections.mjs`, `tests/cloud-connections.test.mjs`, `tests/cloud-remote.test.mjs`, `tests/ftp-fixture.mjs`; migrate every `tests/cloud-*.test.mjs`, `download-cloud.test.mjs`, `music-api.test.mjs`, `music-api-dev.mjs`.
- **api.mjs:** `apiCall(settings, method, path, { body, signal, timeoutMs })` → parsed JSON (throws `CloudError` "Cloud: ..." with `.status`); `uploadFile(settings, path, fields, { signal, onBytes })`; `openFile(settings, id, { signal })` → `{ size, body }` (web stream); `testConnection(settings)` → `{ ok, secure, error? }`; `baseUrl(settings)`.
- **fixture:** `startCloud({ slow, config, key })` → `{ root, cloudDir, settings, api, requests, reads, close }`.
- [ ] Move each test to the fixture; run each file → pass; `npm test` → all pass.

### Task 3: Settings page and frontend
**Files:** `frontend/src/app/features/cloud/cloud.service.ts`, `settings/settings.{html,ts}`, files using `hasPassword`; `backend/tests/ui-cloud.mjs`.
- [ ] Address + Key fields replace host/port/user/password/folder/plain-FTP/storage limit; `cloudOnline` = url && hasKey && online; "Connected (HTTPS)." / "Connected, without encryption (http)." Build + `ng test` pass.

### Task 4: Clean-up and docs
- [ ] Remove `basic-ftp` and `ftp-srv` from `backend/package.json`; README, `music-api/README.md`, ROADMAP, `server.mjs` header comment; full backend + frontend suites pass; dev script works.
