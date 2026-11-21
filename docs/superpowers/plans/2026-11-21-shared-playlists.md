# Shared playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Playlists store songs by identity, and a Shared switch syncs a playlist (and uploads its songs) through the cloud folder so the other laptop sees it.

**Architecture:** `modules/musicPlayer/playlists.mjs` moves from track ids to identity rows and resolves them (library, cloud index, unavailable). A new `modules/cloud/playlistSync.mjs` reconciles local shared playlists with `music/playlists.json` (newest `updatedAt` wins, tombstones for deletes) and queues uploads. The Angular playlist pages gain a Share switch, badges, greyed unavailable songs, and cloud songs in the editor.

**Tech Stack:** Node 26 (`node:test`, `node:sqlite`), existing cloud module (`withCloud`, `startUpload`, `lastIndex`), Angular 22.

**Spec:** `docs/superpowers/specs/2026-11-21-shared-playlists-design.md`

## Global Constraints
- Identity fields: `title, artist, album, duration, isrc, key` (`key = trackKey(artist, title)`).
- Sync: newer `updatedAt` (ms) wins per `uid`; deletes/un-share = `{ uid, deleted: true, updatedAt }`.
- Schedule: at start, every 5 min, on `POST /api/cloud/playlists/sync` (throttled 30 s unless `force`), 2 s after a shared-playlist change.
- Sync never deletes song files. Unshared playlists never reach the cloud.
- Settings gain `name` (default `os.hostname()`), shown as the owner of shared playlists.
- Existing API stays compatible: playlist responses keep `tracks` (library songs only) and accept `trackIds`.

## Review Focus
1. Old playlists after upgrade keep their songs in order (Task 1 `migrates old playlists in order`).
2. A song deleted then downloaded again still appears in its playlists (Task 1 `survives delete and re-download`).
3. Un-sharing on one laptop removes the copy on the other, but not the owner's local playlist (Task 2 `unshare removes the cloud copy only`).
4. A playlist deleted on the other laptop while this one is offline disappears at the next sync, and an older cloud copy never overwrites a newer local edit (Task 2 `newer side wins both ways`).
5. Editing a playlist that contains cloud-only or unavailable songs keeps them (Task 1 `keeps identity refs on update`).

---

### Task 1: Songs by identity, with resolution
**Files:** Modify `backend/modules/musicPlayer/playlists.mjs`, `backend/core/lib.mjs` (+ `sameIdentity(a, b)`), `backend/modules/cloud/upload.mjs` (use `sameIdentity`); Test `backend/tests/playlists.test.mjs` (extend).
**Interfaces (produces):**
- Tables: `playlists(+ uid TEXT UNIQUE, shared INTEGER DEFAULT 0, owner TEXT DEFAULT '', updated_at INTEGER)`, `playlist_songs(playlist_id, position, title, artist, album, duration, isrc, key)`, `playlist_tombstones(uid PRIMARY KEY, deleted_at)`.
- `SongRef = { trackId } | { cloudId } | Identity`; `createPlaylist(name, refs)`, `updatePlaylist(id, name, refs)` (refs may be `trackIds` numbers for compatibility).
- `getPlaylist(id) -> { id, uid, name, shared, owner, updatedAt, tracks: Track[] (library only), songs: (Identity & { trackId: number|null, cloudId: number|null })[] }`; `listPlaylists() -> [{ id, uid, name, count, shared, owner }]`.
- `playlistByUid(uid)`, `upsertFromCloud({ uid, name, owner, updatedAt, songs })`, `removeByUid(uid)`, `setShared(id, shared, owner)`, `sharedPlaylists()`, `tombstones()`, `onSharedChange(fn)` (listener fired after a change to a shared playlist or a delete/unshare).
- [ ] Tests: `migrates old playlists in order`, `survives delete and re-download`, `keeps identity refs on update`, `resolves cloud-only songs from the cloud index`, plus existing tests unchanged → FAIL, implement, PASS, commit `playlists: songs by identity`.

### Task 2: Sync with the cloud
**Files:** Create `backend/modules/cloud/playlistSync.mjs`; Modify `backend/modules/cloud/settings.mjs` (`name`), `backend/modules/cloud/routes.mjs` (`POST /api/cloud/playlists/sync {force?}`, `PUT /api/cloud/playlists/:id/share {shared}`), `backend/server.mjs` (start schedule); Test `backend/tests/cloud-playlists.test.mjs`.
**Interfaces:** `syncPlaylists(settings?) -> { pushed, pulled, removed, uploading: number }`, `scheduleSync(delayMs)`, `startPlaylistSync()`.
- [ ] Tests: `shared playlist is pushed with its songs`, `another laptop's playlist appears here as shared from its owner`, `newer side wins both ways`, `unshare removes the cloud copy only`, `deleting a shared playlist removes it on the other side`, `sharing uploads songs missing from the cloud`, `share route returns the playlist and syncs` → FAIL, implement, PASS, commit `cloud: shared playlist sync`.

### Task 3: Front end
**Files:** Modify `features/musicPlayer/playlist.service.ts` (types, `setShared`, `sync`), `pages/playlist-page.ts` (Share switch, badges, unavailable rows), `pages/playlist-editor.*` (cloud-only songs, keep refs), `library-list/*` (`unavailable` tracks greyed and skipped), `home/home.*` (badges, sync on open), `settings/settings.*` (Your name), `core/api.ts` (`Track.unavailable?`).
- [ ] Spec test in `features/musicPlayer/` for the song mapping (`playlist songs map to library, cloud and unavailable tracks`), build OK, `ng test` PASS, commit `playlists: share switch, badges, cloud songs in the editor`.

### Task 4: End to end and docs
- [ ] Extend `backend/tests/ui-cloud.mjs`: create a playlist, share it, see it in `playlists.json`; a playlist written by "Mum" into `playlists.json` shows on Home as "from Mum" and plays. Update README/OBJECTIVES/ROADMAP. Commit `shared playlists: end-to-end check and docs`.
