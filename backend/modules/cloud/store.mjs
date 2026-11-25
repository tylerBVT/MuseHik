// The cloud seen from this laptop: the music API (api.mjs) behind a small `cloud` object. The server keeps the
// shared files (library.json, playlists.json, songs/) and decides everything that two devices could change at once,
// under its lock. This laptop keeps a copy of the last song list it saw (shown when the cloud cannot be reached).
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { apiCall, openFile, uploadFile } from './api.mjs';
import { usageSummary } from './limits.mjs';
import { OFFLINE_MESSAGE, isConfigured, loadSettings, localFile } from './settings.mjs';

/** The last index read from the cloud, saved on this laptop (shown when the cloud cannot be reached). */
export function lastIndex() {
  try { return JSON.parse(readFileSync(localFile('cloud-library.json'), 'utf8')); } catch { return null; }
}

function keepCopy(songs) {
  try { writeFileSync(localFile('cloud-library.json'), JSON.stringify({ version: 1, songs })); } catch { /* a nicety */ }
}

/** Applies a change to the local copy too, so the player finds a renamed song and forgets a deleted one at once. */
function changeCopy(change) {
  const copy = lastIndex();
  if (copy?.songs) keepCopy(change(copy.songs));
}

/** A refused edit (bad title...), as opposed to a connection problem. */
export class EditError extends Error {}

/** Runs `fn(cloud)`. Throws "Cloud: ..." when the cloud is not set up or switched off on this laptop. */
export async function withCloud(fn, settings = loadSettings()) {
  if (!isConfigured(settings)) throw new Error('Cloud: not set up yet. Fill in the Cloud section in Settings.');
  if (settings.online === false) throw new Error(`Cloud: ${OFFLINE_MESSAGE.replace(/^T/, 't')}`);
  const call = (method, path, options) => apiCall(settings, method, path, options);

  /** PATCH a song: the entry after the change, null for an unknown song, EditError for a refused change. */
  const patchSong = async (id, changes) => {
    try {
      const song = await call('PATCH', `/songs/${id}`, { body: changes });
      changeCopy(songs => songs.map(s => (s.id === id ? song : s)));
      return song;
    } catch (e) {
      if (e.status === 404) return null;
      if (e.status === 400) throw new EditError(e.message.replace(/^Cloud: /, ''));
      throw e;
    }
  };

  const cloud = {
    settings,
    /**
     * The song list. The server first picks up songs added to songs/ by hand and drops songs deleted by hand
     * (`synced`: how many).
     */
    async index() {
      const { songs, synced } = await call('GET', '/songs');
      keepCopy(songs);
      return { songs, synced: synced ?? { added: 0, removed: 0 } };
    },
    /** { storedBytes, storageLimitBytes, songs }. */
    status: () => call('GET', '/status'),
    /** Uploads a file (see api.mjs uploadFile): the new entry, or a CloudError (409 duplicate, 413 no room). */
    upload: (path, fields, options) => uploadFile(settings, path, fields, options),
    /** { size, body } of a song's file, to read as it arrives. */
    open: (song, options) => openFile(settings, song.id, options),
    /** Copies a song's file to `dest` (a path or a writable stream). */
    async download(song, dest, { signal } = {}) {
      const { body } = await cloud.open(song, { signal });
      const out = typeof dest === 'string' ? createWriteStream(dest) : dest;
      await pipeline(Readable.fromWeb(body), out, { signal });
    },
    /**
     * The song menu's Save on a cloud song: new title, artist and/or genre. When the title or the artist changes, the
     * server renames the file "Artist - Title" too (never over another file) and updates the shared playlists.
     */
    editSong: (id, { title, artist, genre } = {}) => patchSong(id, { title, artist, genre }),
    /** Fills in details read from the file's tags (title, artist, album, duration, isrc). */
    updateSong: patchSong,
    async removeSong(id) {
      try {
        await call('DELETE', `/songs/${id}`);
      } catch (e) {
        if (e.status === 404) return false;
        throw e;
      }
      changeCopy(songs => songs.filter(s => s.id !== id));
      return true;
    },
    /** The shared playlists as stored, delete markers ({ uid, deleted: true, updatedAt }) included. */
    playlists: async () => (await call('GET', '/playlists?raw=1')).playlists,
    /** Stores one entry if it is newer than the cloud's: { applied, playlist (what the cloud has now) }. */
    putPlaylist: ({ uid, ...entry }) => call('PUT', `/playlists/${encodeURIComponent(uid)}`, { body: entry }),
  };
  return fn(cloud);
}

/** Brings the list in line with the songs/ folder (the server does it on every list): { added, removed }. */
export function rebuildIndex(settings = loadSettings()) {
  return withCloud(async cloud => (await cloud.index()).synced, settings);
}

/** What the storage bar shows. Never throws: a connection problem comes back as `error`. */
export async function cloudStatus(settings = loadSettings()) {
  if (!isConfigured(settings)) return { configured: false };
  if (settings.online === false) return { configured: true, online: false };
  try {
    const status = await withCloud(cloud => cloud.status(), settings);
    return { configured: true, online: true, ...usageSummary(status) };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}
