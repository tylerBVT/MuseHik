# Cloud extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the monthly cap, show songs added by hand, sort/filter by date, keep download dates, send downloads to the cloud.

**Architecture:** Backend changes in `backend/modules/cloud/*`, `backend/core/library.mjs`, `backend/modules/musicDownloader/*`; frontend in the cloud feature, `library-list`, settings and the downloader. Same patterns as the cloud plan (node:test + ftp-srv fixture, vitest).

**Tech Stack:** Node 26 (node:test, node:sqlite, basic-ftp), Angular 22 signals, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-cloud-extras-design.md`

## Global Constraints
- The app never deletes or overwrites a file on the hosting it did not choose to (only songs deleted in the app, its own `.part` files, its JSON files).
- Only `music/songs/` is scanned; `.part.*` files and non-audio files are ignored (audio = `AUDIO_EXTS`).
- The FTP password never reaches the browser or a log.
- Storage cap 30 GB stays; no traffic cap anywhere.

## Review Focus
- A hand-added file whose name equals the name an upload would pick: the upload must pick another name.
- Opening the Cloud page while offline: the last known list still shows (no new error).
- Hand-added file names without " - ": title = whole name, artist empty.
- A download stopped half-way with "send to cloud": the finished songs still upload.
- "Send to cloud" while an upload runs: queued, not refused.

---

### Task 1: No monthly cap
**Files:** `backend/modules/cloud/{limits,store,settings,routes,cache}.mjs`, `backend/tests/{cloud-limits,cloud-store,cloud-routes,cloud-upload}.test.mjs`, `backend/tests/ftp-fixture.mjs`, `frontend/src/app/features/cloud/{usage-bar.ts,cloud.service.ts}`, `frontend/src/app/settings/settings.{html,ts}`
**Produces:** `usageSummary({usage, settings, storedBytes, date})` → `{month, usedBytes, storedBytes, storageLimitBytes, percent, warning}` (percent/warning are about storage). `cloud.ensureRoom(bytes)` only checks storage. `monthlyLimitGB` gone from settings.
- [ ] Tests first: usageSummary storage percent/warning; ensureRoom never refuses for traffic; a stream works with 11 GB already moved this month; status has no `limitBytes`. Watch fail.
- [ ] Implement; remove `checkTransfer`, `limitMessage`, the 429 path; usage bar shows storage + "Moved this month"; settings field gone.
- [ ] Backend + frontend suites green. Commit.

### Task 2: Songs added by hand
**Files:** `backend/modules/cloud/{store,routes,upload,cache}.mjs`, `backend/tests/cloud-store.test.mjs`, `backend/tests/cloud-routes.test.mjs`, `backend/tests/cloud-upload.test.mjs`
**Produces:** `syncFolder(cloud)` in store.mjs → `{added, removed}`; `rebuildIndex` uses it. GET `/api/cloud/songs` syncs before listing (offline → last list).
- [ ] Tests first: hand-added `A - B.mp3` listed with artist A title B, `addedBy: 'added by hand'`; `NoDash.mp3` → title NoDash; `x.part.mp3`, `notes.txt`, a subfolder ignored; a file deleted by hand leaves the list; nothing changed → `library.json` not rewritten; upload of a song whose name is taken by a hand-added file → `(2)`; playing a hand-added song fills its duration from tags. Watch fail.
- [ ] Implement. Commit.

### Task 3: Download dates in the library
**Files:** `backend/core/library.mjs`, `backend/tests/lib.test.mjs` (or a new `library-dates.test.mjs`), `frontend/src/app/core/api.ts`
**Produces:** column `added_ms` (file birthtime, else mtime), kept on re-index, filled for old rows on scan; `listTracks()` rows carry `addedAt` (ISO). Track type gains `addedAt?: string`; `cloudTrack` passes the cloud `addedAt`.
- [ ] Tests first (fresh file → addedAt within a minute of now; re-index after a change keeps it; a row with no date gets one on scan). Watch fail. Implement. Commit.

### Task 4: Sort and filter
**Files:** `frontend/src/app/features/musicPlayer/library-list/{library-list.ts,.html,.css}`, new `library-list/arrange.ts` + `arrange.spec.ts`, library page and cloud page (enable `sortable`)
**Produces:** `arrange(tracks, {query, sort, since, now})`; sort `default|title|artist|newest|oldest`, since `any|7|30|365` (days). Input `sortable` on LibraryList; date shown in the artist line when known.
- [ ] Spec first (each sort, each period, unknown dates sort last and are kept only for "any", query still works). Watch fail. Implement. Commit.

### Task 5: Send to cloud from the downloader
**Files:** `backend/modules/cloud/upload.mjs` (`queueUpload`), `backend/modules/musicDownloader/{jobs,routes}.mjs` (`cloudSelection(job)`, `toCloud`), tests `cloud-upload.test.mjs` + new `download-cloud.test.mjs`, frontend `link-input.{ts,html}`
**Produces:** `queueUpload(selection, settings)` → `{jobId}` or `{queued: true}`; runs right after the active upload. `cloudSelection(job)` → `{paths: job.files, trackIds: skippedList match ids}`. POST `/api/download {url, toCloud}`; 400 when the cloud is not set up. Job gets `cloud: {songs, queued|jobId}` after it ends.
- [ ] Tests first (queue runs after the active one; cloudSelection; 400 when not set up). Watch fail. Implement + tick box + "Sending N songs to the cloud" line with a link. Commit.

### Task 6: Check in the browser, docs
- [ ] Extend `backend/tests/ui-cloud.mjs`: hand-added file appears; sort by newest; no traffic cap text. Run it.
- [ ] README/OBJECTIVES lines. Commit.
