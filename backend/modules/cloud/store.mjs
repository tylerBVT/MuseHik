// The cloud's shared state, kept as small JSON files in the cloud folder (no database needed):
//   library.json  the index of every song on the cloud (uploaded by either laptop, or added by hand)
//   playlists.json  shared playlists (playlistSync.mjs)
// Two laptops can write at the same time and FTP has no locks, so every change re-reads the file right before
// writing it. The songs/ folder stays the truth: rebuildIndex() repairs the index from it.
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { extname } from 'node:path';
import { AUDIO_EXTS, fileBase, trackKey } from '../../core/lib.mjs';
import { borrow } from './connections.mjs';
import { GB, checkStorage, usageSummary } from './limits.mjs';
import { OFFLINE_MESSAGE, isConfigured, loadSettings, localFile } from './settings.mjs';

const EMPTY_INDEX = () => ({ version: 1, nextId: 1, songs: [] });
export const songPath = song => `songs/${song.file}`;

/** The last index read from the cloud, saved on this laptop (shown when the cloud cannot be reached). */
export function lastIndex() {
  try { return JSON.parse(readFileSync(localFile('cloud-library.json'), 'utf8')); } catch { return null; }
}

/**
 * Runs `fn(cloud)` on one of the kept-open connections (connections.mjs): `lane` 'listen' (default) for playing,
 * lists and small changes, 'transfer' for uploads and saving songs to this laptop.
 */
export async function withCloud(fn, settings = loadSettings(), { lane = 'listen' } = {}) {
  if (!isConfigured(settings)) throw new Error('Cloud: not set up yet. Fill in the Cloud section in Settings.');
  if (settings.online === false) throw new Error(`Cloud: ${OFFLINE_MESSAGE.replace(/^T/, 't')}`);
  const { session, release } = await borrow(lane, settings);

  const keepCopy = index => {
    try { writeFileSync(localFile('cloud-library.json'), JSON.stringify(index)); } catch { /* the copy is a nicety */ }
    return index;
  };
  const readIndex = async () => keepCopy((await session.readJson('library.json')) ?? EMPTY_INDEX());
  const writeIndex = async index => { await session.writeJson('library.json', index); keepCopy(index); };

  const cloud = {
    session,
    settings,
    index: readIndex,
    writeIndex,
    async storedBytes() {
      return (await readIndex()).songs.reduce((sum, s) => sum + (s.size || 0), 0);
    },
    /** Throws a LimitError if keeping `bytes` more (`storage: true`) would pass the storage cap. Traffic is free. */
    async ensureRoom(bytes, { storage = false } = {}) {
      if (storage) checkStorage({ storedBytes: await cloud.storedBytes(), storageLimitBytes: settings.storageLimitGB * GB, bytes });
    },
    async addSong(entry) {
      const index = await readIndex();
      // The other laptop may already list this file as "added by hand" (it looked between our rename and now):
      // replace that entry, keeping its id.
      const early = index.songs.find(s => s.file === entry.file);
      const song = {
        id: early?.id ?? index.nextId, file: entry.file, title: entry.title, artist: entry.artist || '',
        album: entry.album || '', duration: entry.duration || 0, isrc: entry.isrc || null,
        key: trackKey(entry.artist || '', entry.title), size: entry.size, addedBy: entry.addedBy || hostname(),
        addedAt: new Date().toISOString(),
      };
      index.songs = index.songs.filter(s => s !== early);
      index.songs.push(song);
      if (!early) index.nextId = Math.max(index.nextId, song.id) + 1;
      await writeIndex(index);
      return song;
    },
    /** Changes some fields of one song (re-reads the index first: the other laptop may have written it). */
    async updateSong(id, patch) {
      const index = await readIndex();
      const song = index.songs.find(s => s.id === id);
      if (!song) return null;
      Object.assign(song, patch);
      await writeIndex(index);
      return song;
    },
    /**
     * The song menu's Save on a cloud song: new title, artist and/or genre in the shared list. When the title or the
     * artist changes, the file on the cloud is renamed "Artist - Title" too (never over another file). Same id, so a
     * copy cached under it stays valid. Returns the updated entry, or null for an unknown song.
     */
    async editSong(id, { title, artist, genre } = {}) {
      const index = await readIndex();
      const song = index.songs.find(s => s.id === id);
      if (!song) return null;
      const next = {
        title: String(title ?? song.title).trim(),
        artist: String(artist ?? song.artist ?? '').trim(),
        genre: String(genre ?? song.genre ?? '').trim(),
      };
      if (!next.title) throw new EditError('A song needs a title.');
      if (next.title.length > 200 || next.artist.length > 200 || next.genre.length > 60) throw new EditError('That is too long.');
      let file = song.file;
      if (next.title !== song.title || next.artist !== (song.artist || '')) {
        const ext = extname(song.file);
        const base = fileBase(next.artist, next.title);
        const taken = new Set(index.songs.filter(s => s.id !== id).map(s => s.file.toLowerCase()));
        file = `${base}${ext}`;
        for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base} (${n})${ext}`;
        if (file !== song.file) await session.rename(songPath(song), songPath({ file }));
      }
      return cloud.updateSong(id, { ...next, file, key: trackKey(next.artist, next.title) });
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
    release();
  }
}

/** A refused edit (bad title...), as opposed to a connection problem. */
export class EditError extends Error {}

/** Who "added" a song found in songs/ that no laptop uploaded (put there with FileZilla or the hosting's panel). */
export const BY_HAND = 'added by hand';

/**
 * Brings the index in line with the songs/ folder: audio files it lacks are added (artist and title from the file
 * name "Artist - Title.mp3"; the real tags are filled in when the song is first played), entries whose file is gone
 * are dropped. Upload leftovers (*.part.*) and non-audio files are ignored. The index is only written on a change.
 */
export async function syncFolder(cloud) {
  const files = (await cloud.session.list('songs'))
    .filter(f => AUDIO_EXTS.has(extname(f.name).toLowerCase()) && !/\.part\.\w+$/i.test(f.name));
  const names = new Set(files.map(f => f.name));
  const index = await cloud.index();
  // An empty answer while the list has songs is more likely a server hiccup than every song deleted by hand: keep
  // the list (titles, lengths, dates). Songs deleted in the app leave it anyway.
  if (!files.length) return { added: 0, removed: 0 };
  const known = new Set(index.songs.map(s => s.file));
  const kept = index.songs.filter(s => names.has(s.file));
  const removed = index.songs.length - kept.length;
  let added = 0;
  for (const f of files) {
    if (known.has(f.name)) continue;
    const base = f.name.slice(0, -extname(f.name).length);
    const dash = base.indexOf(' - ');
    const artist = dash > 0 ? base.slice(0, dash) : '';
    const title = dash > 0 ? base.slice(dash + 3) : base;
    kept.push({
      id: index.nextId++, file: f.name, title, artist, album: '', duration: 0, isrc: null,
      key: trackKey(artist, title), size: f.size, addedBy: BY_HAND, addedAt: f.modifiedAt || new Date().toISOString(),
    });
    added++;
  }
  if (added || removed) {
    index.songs = kept;
    await cloud.writeIndex(index);
  }
  return { added, removed };
}

/** Repairs the index from the songs/ folder (see syncFolder). */
export function rebuildIndex(settings = loadSettings()) {
  return withCloud(syncFolder, settings);
}

/** What the storage bar shows. Never throws: a connection problem comes back as `error`. */
export async function cloudStatus(settings = loadSettings()) {
  if (!isConfigured(settings)) return { configured: false };
  if (settings.online === false) return { configured: true, online: false };
  try {
    return await withCloud(async cloud => ({
      configured: true, online: true, ...usageSummary({ settings, storedBytes: await cloud.storedBytes() }),
    }), settings);
  } catch (e) {
    return { configured: true, error: e.message };
  }
}
