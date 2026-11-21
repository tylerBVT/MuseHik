# Shared playlists (design, 2026-11-21)

## Why
Two people, one laptop each, one shared cloud folder. Each makes playlists on their own laptop from songs they
have; sharing a playlist puts it (and its songs) on the cloud so the other laptop sees it and can play it. Each
person only ever edits their own playlists (not enforced). The owner also asked for playlists made from cloud songs.

## Decisions (owner)
- One kind of playlist with a **Shared** switch, not separate "local" and "cloud" playlists.
- Shared playlists are **synced** between the laptop and the cloud.
- Fix the flagged weakness: playlists must not point at local song numbers.

## Goals
- A playlist stores songs by **identity** (title, artist, album, duration, ISRC, cleaned key), in order.
  Each entry is resolved when shown: local library file, else cloud song, else "not available" (greyed, skipped).
  Survives delete + re-download, rescans, and moving between laptops. Existing playlists are migrated on start.
- Playlist page: a **Share** switch. Home and playlist page show "Shared" on mine and "from <name>" on others'.
- Sharing uploads the playlist's local songs that are not on the cloud yet; songs added later are uploaded at the
  next sync. Traffic counts against the monthly budget as usual.
- The playlist editor also lists cloud songs that are not on this laptop, so playlists can be made from them.
- Settings > Cloud: **Your name** (shown on playlists you share; default the computer name).

## Non-goals / anti-goals
- No permissions or ownership enforcement. No merging of simultaneous edits of one playlist.
- A playlist that is not shared never leaves the laptop.
- Syncing must never delete a song file, only playlists.

## Approaches considered
1. **One playlist kind + Shared switch, synced, songs by identity** (picked).
2. Separate cloud playlists (their own page, cloud songs only) and "upload a playlist" as a one-time copy:
   two lists to manage and they drift apart; rejected by the owner.
3. Shared editing with merges: not needed, each person edits only their own playlists.

## Design
### Song identity (local database)
`playlist_songs(playlist_id, position, title, artist, album, duration, isrc, key)` replaces
`playlist_tracks(track_id)`. On start, rows of `playlist_tracks` are converted once (old table left untouched).
Resolution: local = the library's duplicate check (`findDuplicate`); cloud = same ISRC, or same key with a
compatible length, in the last known cloud index; else unavailable. Repeated songs in one playlist are dropped.

### Sync
- `playlists` gets `uid` (random, stable across laptops), `shared`, `owner` (name of who shared it), `updated_at` (ms).
  A deleted shared playlist leaves a tombstone `(uid, deleted_at)` locally.
- Cloud file `music/playlists.json`: `{ version: 1, playlists: [{ uid, name, owner, updatedAt, songs: [identity] } |
  { uid, deleted: true, updatedAt }] }`.
- Rule per playlist uid: the newer `updatedAt` wins, both ways. Un-sharing or deleting a shared playlist writes a
  `deleted` entry; the other laptop then removes its copy. Playlists received from the cloud are stored as shared.
- Runs at server start, every 5 minutes, when the home page asks (at most every 30 s), and 2 s after a change to a
  shared playlist. After syncing, songs of shared playlists that are on this laptop but not on the cloud are uploaded
  (one upload job; skipped if one is running).

### Screens
```
Home tile:      Road trip            Road trip            Mum's mix
                12 songs · Shared    12 songs             8 songs · from Mum
Playlist page:  [ Edit ] [ Delete ] [ Shared ◉ ]   (status line: "Uploading 3 songs to the cloud...")
                greyed row: "Song title — not available (not on this laptop or the cloud)"
Editor:         songs list = library songs + cloud-only songs (tagged "cloud")
```

## Left to the builder
API shapes, module boundaries, sync scheduling details, wording.
