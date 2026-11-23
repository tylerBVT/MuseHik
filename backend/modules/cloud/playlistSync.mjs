// Shared playlists: keeps this laptop's shared playlists and the cloud's playlists.json in step.
// Rule, per playlist (named by its uid on every laptop): the side changed last wins, both ways. Unsharing or
// deleting a shared playlist writes { uid, deleted: true }, so the other laptop drops its copy. Each person only
// edits their own playlists, so "last change wins" never throws real work away.
// After syncing, songs of shared playlists that this laptop has but the cloud lacks are uploaded.
import { hostname } from 'node:os';
import { findDuplicate } from '../../core/library.mjs';
import { sameIdentity } from '../../core/lib.mjs';
import {
  clearTombstone, onSharedChange, playlistRows, removeByUid, tombstones, unshareByUid, upsertFromCloud,
} from '../musicPlayer/playlists.mjs';
import { isConfigured, isOnline, loadSettings } from './settings.mjs';
import { withCloud } from './store.mjs';
import { activeUpload, startUpload } from './upload.mjs';

const EVERY_MS = 5 * 60 * 1000;
const THROTTLE_MS = 30 * 1000;

/** The name shown on playlists this laptop shares. */
export const ownerName = (settings = loadSettings()) => settings.name || hostname();

const forCloud = (local, settings) => ({
  uid: local.uid, name: local.name, owner: local.owner || ownerName(settings), updatedAt: local.updatedAt,
  songs: local.songs.map(({ title, artist, album, duration, isrc, key }) => ({ title, artist, album, duration, isrc, key })),
});

async function reconcile(settings) {
  return withCloud(async cloud => {
    const remote = (await cloud.session.readJson('playlists.json')) ?? { version: 1, playlists: [] };
    const entries = new Map(remote.playlists.map(p => [p.uid, p]));
    const counts = { pushed: 0, pulled: 0, removed: 0 };
    let dirty = false;
    const put = entry => { entries.set(entry.uid, entry); dirty = true; };

    const locals = playlistRows();
    const localUids = new Set(locals.map(l => l.uid));
    for (const local of locals) {
      const entry = entries.get(local.uid);
      if (!entry) {
        if (local.shared) { put(forCloud(local, settings)); counts.pushed++; }
      } else if (entry.updatedAt > local.updatedAt) {
        if (!entry.deleted) { upsertFromCloud(entry); counts.pulled++; }
        // Only a playlist received from the other laptop is removed; one made here just stops being shared.
        else if (local.shared && local.fromCloud) { removeByUid(local.uid); counts.removed++; }
        else if (local.shared) unshareByUid(local.uid, entry.updatedAt);
      } else if (local.updatedAt > entry.updatedAt) {
        if (local.shared) { put(forCloud(local, settings)); counts.pushed++; }
        else if (!entry.deleted) put({ uid: local.uid, deleted: true, updatedAt: local.updatedAt }); // unshared here
      }
    }

    const tombs = new Map(tombstones().map(t => [t.uid, t.deletedAt]));
    for (const entry of entries.values()) {
      if (localUids.has(entry.uid)) continue;
      const deletedAt = tombs.get(entry.uid);
      if (entry.deleted) continue;
      if (deletedAt !== undefined && deletedAt >= entry.updatedAt) {
        put({ uid: entry.uid, deleted: true, updatedAt: deletedAt }); // deleted here after the last edit
      } else {
        upsertFromCloud(entry); // new, or edited on the other laptop after it was deleted here: the edit wins
        if (deletedAt !== undefined) clearTombstone(entry.uid);
        counts.pulled++;
      }
    }

    if (dirty) await cloud.session.writeJson('playlists.json', { version: 1, playlists: [...entries.values()] });
    // The cloud now knows about every delete made here.
    for (const uid of tombs.keys()) if (!entries.has(uid) || entries.get(uid).deleted) clearTombstone(uid);

    // Songs of shared playlists that this laptop has and the cloud does not: to upload.
    const onCloud = (await cloud.index()).songs;
    const missing = new Set();
    for (const local of playlistRows().filter(l => l.shared)) {
      for (const song of local.songs) {
        if (onCloud.some(c => sameIdentity(c, song))) continue;
        const mine = findDuplicate({ title: song.title, artist: song.artist, duration: song.duration, isrc: song.isrc });
        if (mine) missing.add(mine.id);
      }
    }
    return { ...counts, missing: [...missing] };
  }, settings);
}

let running = null;
let lastSyncAt = 0;

/** One full sync (never two at once). Returns { pushed, pulled, removed, uploading }. */
export function syncPlaylists({ settings = loadSettings() } = {}) {
  if (!isConfigured(settings)) return Promise.resolve({ skipped: true, reason: 'The cloud is not set up.' });
  if (!isOnline(settings)) return Promise.resolve({ skipped: true, reason: 'The cloud is offline on this laptop.' });
  running ??= (async () => {
    try {
      const { missing, ...counts } = await reconcile(settings);
      let uploading = 0;
      if (missing.length && !activeUpload()) {
        startUpload({ trackIds: missing }, settings);
        uploading = missing.length;
      }
      lastSyncAt = Date.now();
      return { ...counts, uploading };
    } finally {
      running = null;
    }
  })();
  return running;
}

/** For the home page: syncs unless one ran in the last 30 s (or `force`). */
export function requestSync({ force = false } = {}) {
  if (!force && Date.now() - lastSyncAt < THROTTLE_MS) return Promise.resolve({ skipped: true, lastSyncAt });
  return syncPlaylists();
}

let timer = null;
/** Syncs after `delayMs` (later calls push it back, so a burst of edits makes one sync). */
export function scheduleSync(delayMs = 2000) {
  clearTimeout(timer);
  timer = setTimeout(() => syncPlaylists().catch(e => console.error('Playlist sync:', e.message)), delayMs);
  timer.unref?.();
}

/** At server start: sync now, then every 5 minutes, and shortly after any change to a shared playlist. */
export function startPlaylistSync() {
  onSharedChange(() => scheduleSync(2000));
  scheduleSync(0);
  setInterval(() => syncPlaylists().catch(e => console.error('Playlist sync:', e.message)), EVERY_MS).unref();
}
