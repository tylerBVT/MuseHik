// Cloud songs played on this laptop are kept in a local cache, so a song crosses the network once per laptop.
// The cache lives outside the project (heavyDir, not synced by OneDrive) and is capped in size: when it is full,
// the song played the longest time ago goes first. Files never expire by age: cloud songs never change.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { heavyDir } from '../../core/config.mjs';
import { db, findDuplicate } from '../../core/library.mjs';
import { GB } from './limits.mjs';
import { loadSettings } from './settings.mjs';
import { songPath, withCloud } from './store.mjs';

export const cacheDir = process.env.CLOUD_CACHE_DIR || join(heavyDir, 'cloudCache');

db.exec(`CREATE TABLE IF NOT EXISTS cloud_cache (
  song_id INTEGER PRIMARY KEY, file TEXT NOT NULL, size INTEGER NOT NULL, last_used INTEGER NOT NULL)`);
const cq = {
  get: db.prepare('SELECT * FROM cloud_cache WHERE song_id = ?'),
  put: db.prepare('INSERT OR REPLACE INTO cloud_cache (song_id, file, size, last_used) VALUES (?, ?, ?, ?)'),
  touch: db.prepare('UPDATE cloud_cache SET last_used = ? WHERE song_id = ?'),
  remove: db.prepare('DELETE FROM cloud_cache WHERE song_id = ?'),
  oldestFirst: db.prepare('SELECT * FROM cloud_cache ORDER BY last_used'),
  ids: db.prepare('SELECT song_id FROM cloud_cache'),
};

// Strictly increasing "now", so two plays in the same millisecond still have an order.
let lastTick = 0;
const tick = () => (lastTick = Math.max(lastTick + 1, Date.now()));

const cachedFile = song => join(cacheDir, `${song.id}${extname(song.file).toLowerCase() || '.mp3'}`);

/** Where this cloud song can be played from without the network: the local library, the cache, or null. */
export function localSource(song) {
  const mine = findDuplicate({ title: song.title, artist: song.artist, duration: song.duration, isrc: song.isrc });
  if (mine && existsSync(mine.path)) return { path: mine.path, from: 'library' };
  const row = cq.get.get(song.id);
  if (row && existsSync(row.file)) return { path: row.file, from: 'cache' };
  if (row) cq.remove.run(song.id); // file deleted by hand
  return null;
}

export const touch = song => cq.touch.run(tick(), song.id);
export const cachedIds = () => new Set(cq.ids.all().map(r => r.song_id));

/** Removes the least recently played songs until the cache fits in `limitBytes`. `keepId` is never removed. */
export function evict(limitBytes, keepId) {
  const rows = cq.oldestFirst.all();
  let total = rows.reduce((sum, r) => sum + r.size, 0);
  for (const row of rows) {
    if (total <= limitBytes) break;
    if (row.song_id === keepId) continue;
    rmSync(row.file, { force: true });
    cq.remove.run(row.song_id);
    total -= row.size;
  }
}

const inFlight = new Map(); // song id -> Promise<path>: one download per song, however many ask

/** The cached file of a cloud song, downloading it first if needed (added to this month's traffic count). */
export function fetchSong(song, settings = loadSettings()) {
  const ready = localSource(song); // in the local library (free) or already cached: no download
  if (ready) {
    if (ready.from === 'cache') touch(song);
    return Promise.resolve(ready.path);
  }
  if (inFlight.has(song.id)) return inFlight.get(song.id);
  const job = (async () => {
    mkdirSync(cacheDir, { recursive: true });
    const target = cachedFile(song);
    const part = `${target}.part`;
    try {
      await withCloud(cloud => cloud.session.download(songPath(song), part), settings);
      await rename(part, target);
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    cq.put.run(song.id, target, (await stat(target)).size, tick());
    evict(settings.cacheLimitGB * GB, song.id);
    return target;
  })().finally(() => inFlight.delete(song.id));
  inFlight.set(song.id, job);
  return job;
}
