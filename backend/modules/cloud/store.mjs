// The cloud's shared state, kept as two small JSON files in the cloud folder (no database needed):
//   library.json  the index of every song uploaded by either laptop
//   usage.json    traffic per month, added to by both laptops
// Two laptops can write at the same time and FTP has no locks, so every change re-reads the file right before
// writing it. The songs/ folder stays the truth: rebuildIndex() repairs the index from it.
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { extname } from 'node:path';
import { trackKey } from '../../core/lib.mjs';
import { GB, checkStorage, monthKey, usageSummary } from './limits.mjs';
import { openSession } from './remote.mjs';
import { isConfigured, loadSettings, localFile } from './settings.mjs';

const EMPTY_INDEX = () => ({ version: 1, nextId: 1, songs: [] });
export const songPath = song => `songs/${song.file}`;

/** The last index read from the cloud, saved on this laptop (shown when the cloud cannot be reached). */
export function lastIndex() {
  try { return JSON.parse(readFileSync(localFile('cloud-library.json'), 'utf8')); } catch { return null; }
}

/**
 * Runs `fn(cloud)` on one FTP session. When it ends (even by an error) the bytes it moved are added to this month's
 * traffic in usage.json, so both laptops count against the same budget.
 */
export async function withCloud(fn, settings = loadSettings()) {
  if (!isConfigured(settings)) throw new Error('Cloud: not set up yet. Fill in the Cloud section in Settings.');
  const session = await openSession(settings);
  const startUsage = (await session.readJson('usage.json')) ?? { months: {} };
  const month = monthKey();
  const startBytes = startUsage.months?.[month]?.bytes ?? 0;

  const keepCopy = index => {
    try { writeFileSync(localFile('cloud-library.json'), JSON.stringify(index)); } catch { /* the copy is a nicety */ }
    return index;
  };
  const readIndex = async () => keepCopy((await session.readJson('library.json')) ?? EMPTY_INDEX());
  const writeIndex = async index => { await session.writeJson('library.json', index); keepCopy(index); };
  const usedBytes = () => startBytes + session.bytes;

  const cloud = {
    session,
    settings,
    index: readIndex,
    writeIndex,
    usedBytes,
    async storedBytes() {
      return (await readIndex()).songs.reduce((sum, s) => sum + (s.size || 0), 0);
    },
    /** Throws a LimitError if keeping `bytes` more (`storage: true`) would pass the storage cap. Traffic is free. */
    async ensureRoom(bytes, { storage = false } = {}) {
      if (storage) checkStorage({ storedBytes: await cloud.storedBytes(), storageLimitBytes: settings.storageLimitGB * GB, bytes });
    },
    async addSong(entry) {
      const index = await readIndex();
      const song = {
        id: index.nextId, file: entry.file, title: entry.title, artist: entry.artist || '', album: entry.album || '',
        duration: entry.duration || 0, isrc: entry.isrc || null, key: trackKey(entry.artist || '', entry.title),
        size: entry.size, addedBy: entry.addedBy || hostname(), addedAt: new Date().toISOString(),
      };
      index.songs.push(song);
      index.nextId = Math.max(index.nextId, song.id) + 1;
      await writeIndex(index);
      return song;
    },
    async removeSong(id) {
      const index = await readIndex();
      const song = index.songs.find(s => s.id === id);
      if (!song) return false;
      try { await session.remove(songPath(song)); } catch (e) { if (!/no such file|not found|ENOENT|550/i.test(e.message)) throw e; }
      const fresh = await readIndex();
      fresh.songs = fresh.songs.filter(s => s.id !== id);
      await writeIndex(fresh);
      return true;
    },
  };

  try {
    return await fn(cloud);
  } finally {
    try {
      const usage = (await session.readJson('usage.json')) ?? { months: {} };
      usage.months ??= {};
      const spent = session.bytes;
      usage.months[month] = { bytes: (usage.months[month]?.bytes ?? 0) + spent };
      await session.writeJson('usage.json', usage);
    } catch (e) {
      console.error('Could not record cloud traffic:', e.message);
    } finally {
      await session.close();
    }
  }
}

/** Repairs the index from the songs/ folder: adds files it lacks, drops entries whose file is gone. */
export function rebuildIndex(settings = loadSettings()) {
  return withCloud(async cloud => {
    const files = await cloud.session.list('songs');
    const names = new Set(files.map(f => f.name));
    const index = await cloud.index();
    const known = new Set(index.songs.map(s => s.file));
    const kept = index.songs.filter(s => names.has(s.file));
    const removed = index.songs.length - kept.length;
    let added = 0;
    for (const f of files) {
      if (known.has(f.name) || /\.part\.\w+$/i.test(f.name)) continue;
      const base = f.name.slice(0, -extname(f.name).length || undefined);
      const dash = base.indexOf(' - ');
      const artist = dash > 0 ? base.slice(0, dash) : '';
      const title = dash > 0 ? base.slice(dash + 3) : base;
      kept.push({
        id: index.nextId++, file: f.name, title, artist, album: '', duration: 0, isrc: null,
        key: trackKey(artist, title), size: f.size, addedBy: hostname(), addedAt: new Date().toISOString(),
      });
      added++;
    }
    index.songs = kept;
    await cloud.writeIndex(index);
    return { added, removed };
  }, settings);
}

/** What the usage bars show. Never throws: a connection problem comes back as `error`. */
export async function cloudStatus(settings = loadSettings()) {
  if (!isConfigured(settings)) return { configured: false };
  try {
    return await withCloud(async cloud => {
      const usage = await cloud.session.readJson('usage.json');
      const summary = usageSummary({ usage, settings, storedBytes: await cloud.storedBytes() });
      return { configured: true, ...summary, usedBytes: Math.max(summary.usedBytes, cloud.usedBytes()) };
    }, settings);
  } catch (e) {
    return { configured: true, error: e.message };
  }
}
