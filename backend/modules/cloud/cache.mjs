// Cloud songs played on this laptop are kept in a local cache, so a song crosses the network once per laptop.
// The cache lives outside the project (heavyDir, not synced by OneDrive) and is capped in size: when it is full,
// the song played the longest time ago goes first. Files never expire by age: cloud songs never change.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import { heavyDir } from '../../core/config.mjs';
import { db, findDuplicate } from '../../core/library.mjs';
import { GB } from './limits.mjs';
import { loadSettings } from './settings.mjs';
import { withCloud } from './store.mjs';

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

/**
 * A song added by hand is listed with what its file name says and no length. Once it is on this laptop, its own tags
 * are read and written to the shared list (never fatal: the song plays either way).
 */
async function fillTags(cloud, song, path) {
  try {
    const { common, format } = await parseFile(path, { duration: true, skipCovers: true });
    const patch = { duration: format.duration || 0 };
    if (common.title) patch.title = common.title;
    if (common.artist) patch.artist = common.artist;
    if (common.album) patch.album = common.album;
    if (common.isrc?.[0]) patch.isrc = common.isrc[0];
    await cloud.updateSong(song.id, patch);
  } catch (e) {
    console.error(`Could not read the tags of "${song.file}":`, e.message);
  }
}

const inFlight = new Map(); // song id -> Download: one download per song, however many ask

/**
 * Starts downloading a cloud song into the cache (or joins the download already running) and returns it at once,
 * so it can be played while it downloads (core/http.mjs streamGrowing):
 *   { path (the .part file), target, size (exact, from the server; 0 if unknown), written (bytes on disk), done, error,
 *     ready (resolves once the size is known, or it ended), promise (the cached file, tags read), changed() }
 * The download goes on if the listener leaves: the finished file is the song's cached copy.
 */
export function startFetch(song, settings = loadSettings()) {
  const running = inFlight.get(song.id);
  if (running) return running;
  const target = cachedFile(song);
  let wake = [];
  const notify = () => { const waiting = wake; wake = []; for (const resolve of waiting) resolve(); };
  let markReady;
  const dl = {
    id: song.id, path: `${target}.part`, target, size: 0, written: 0, done: false, error: null,
    ready: new Promise(resolve => { markReady = resolve; }),
    changed: () => new Promise(resolve => { wake.push(resolve); setTimeout(resolve, 250).unref?.(); }),
  };
  dl.promise = (async () => {
    mkdirSync(cacheDir, { recursive: true });
    const file = await open(dl.path, 'w');
    try {
      await withCloud(async cloud => {
        const { size, body } = await cloud.open(song);
        dl.size = size;
        markReady();
        // Counts the bytes really on disk, so a reader never asks for bytes not written yet.
        const sink = new Writable({
          write(chunk, _encoding, done) {
            file.write(chunk).then(() => { dl.written += chunk.length; notify(); done(); }, done);
          },
        });
        await pipeline(Readable.fromWeb(body), sink);
      }, settings);
      await file.close();
      await rename(dl.path, target);
    } catch (e) {
      await file.close().catch(() => {});
      await rm(dl.path, { force: true });
      throw e;
    }
    cq.put.run(song.id, target, (await stat(target)).size, tick());
    evict(settings.cacheLimitGB * GB, song.id);
    dl.done = true;
    notify();
    // A song added by hand has no length yet: read its tags now that it is here (the song already plays).
    if (!song.duration) await withCloud(cloud => fillTags(cloud, song, target), settings).catch(() => {});
    return target;
  })();
  dl.promise.catch(e => { dl.error = e; notify(); markReady(); }).finally(() => inFlight.delete(song.id));
  inFlight.set(song.id, dl);
  return dl;
}

/** The file of a cloud song: the library copy, the cached copy, or (after downloading it) a new cached copy. */
export function fetchSong(song, settings = loadSettings()) {
  const ready = localSource(song); // in the local library (free) or already cached: no download
  if (ready) {
    if (ready.from === 'cache') touch(song);
    return Promise.resolve(ready.path);
  }
  return startFetch(song, settings).promise;
}
