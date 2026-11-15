// Library index (idea from Harmony: a SQLite index is the source of truth, the folder is only reconciled
// into it). Uses Node's built-in SQLite, so no database dependency.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { outputDir } from './engine.mjs';
import { sameLength, trackKey } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.opus', '.ogg', '.flac', '.wav']);

mkdirSync(join(root, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.LIBRARY_DB || join(root, 'data', 'library.db'));
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    isrc TEXT,
    key TEXT NOT NULL,
    source TEXT,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS tracks_key ON tracks(key);
  CREATE INDEX IF NOT EXISTS tracks_isrc ON tracks(isrc);
  CREATE INDEX IF NOT EXISTS tracks_source ON tracks(source);
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  );
`);

const q = {
  byPath: db.prepare('SELECT * FROM tracks WHERE path = ?'),
  byId: db.prepare('SELECT * FROM tracks WHERE id = ?'),
  byIsrc: db.prepare('SELECT * FROM tracks WHERE isrc = ? COLLATE NOCASE'),
  bySource: db.prepare('SELECT * FROM tracks WHERE source = ?'),
  byKey: db.prepare('SELECT * FROM tracks WHERE key = ?'),
  upsert: db.prepare(`
    INSERT INTO tracks (path, title, artist, album, duration, isrc, key, source, size, mtime_ms)
    VALUES (@path, @title, @artist, @album, @duration, @isrc, @key, @source, @size, @mtime_ms)
    ON CONFLICT(path) DO UPDATE SET title=@title, artist=@artist, album=@album, duration=@duration,
      isrc=@isrc, key=@key, source=COALESCE(@source, source), size=@size, mtime_ms=@mtime_ms`),
  remove: db.prepare('DELETE FROM tracks WHERE path = ?'),
  all: db.prepare('SELECT id, title, artist, album, duration FROM tracks ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE'),
  paths: db.prepare('SELECT path, size, mtime_ms FROM tracks'),
  count: db.prepare('SELECT COUNT(*) AS n FROM tracks'),
};

async function readTags(path) {
  const info = await stat(path);
  let meta = null;
  try { meta = await parseFile(path, { duration: true, skipCovers: true }); } catch { /* unreadable tags: fall back to the file name */ }
  const common = meta?.common ?? {};
  const fallback = basename(path, extname(path));
  const title = common.title || fallback;
  const artist = common.artist || '';
  return {
    path, title, artist, album: common.album || '',
    duration: meta?.format?.duration || 0,
    isrc: common.isrc?.[0] || null,
    key: trackKey(artist, title),
    size: info.size, mtime_ms: Math.floor(info.mtimeMs),
  };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (AUDIO_EXTS.has(extname(entry.name).toLowerCase())) yield full;
  }
}

/** Reconciles the folder with the index: parses new/changed files, forgets deleted ones. */
export async function scanLibrary() {
  const known = new Map(q.paths.all().map(r => [r.path, r]));
  let added = 0;
  try {
    for await (const path of walk(outputDir)) {
      const old = known.get(path);
      known.delete(path);
      const info = await stat(path);
      if (old && old.size === info.size && old.mtime_ms === Math.floor(info.mtimeMs)) continue;
      q.upsert.run({ source: null, ...(await readTags(path)) });
      added++;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // music folder not created yet = empty library
  }
  for (const path of known.keys()) q.remove.run(path);
  return { added, removed: known.size, total: q.count.get().n };
}

/** Registers one freshly written file (keeps the platform source id, e.g. "youtube:abc"). */
export async function addFile(path, source = null) {
  q.upsert.run({ ...(await readTags(path)), source });
}

/**
 * Is this song already in the library? Checks, in order: ISRC, source id, then the cleaned-up
 * artist+title key with a compatible duration. Returns the existing row or undefined.
 */
export function findDuplicate({ title, artist, duration, isrc, source }) {
  if (isrc) { const hit = q.byIsrc.get(isrc); if (hit) return hit; }
  if (source) { const hit = q.bySource.get(source); if (hit) return hit; }
  if (title) return q.byKey.all(trackKey(artist, title)).find(r => sameLength(r.duration, duration));
  return undefined;
}

export const listTracks = () => q.all.all();
export const getTrack = id => q.byId.get(id);
export const hasPath = path => Boolean(q.byPath.get(path));

/** Embedded cover art of a file, or null. */
export async function coverOf(path) {
  try {
    const meta = await parseFile(path, { skipCovers: false });
    const picture = meta.common.picture?.[0];
    return picture ? { data: Buffer.from(picture.data), type: picture.format || 'image/jpeg' } : null;
  } catch { return null; }
}

// ---- Playlists: a name plus an ordered list of library tracks. Deleting a playlist never deletes songs. ----
const pq = {
  all: db.prepare(`SELECT p.id, p.name, COUNT(pt.track_id) AS count FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id GROUP BY p.id ORDER BY p.name COLLATE NOCASE`),
  one: db.prepare('SELECT id, name FROM playlists WHERE id = ?'),
  tracks: db.prepare(`SELECT t.id, t.title, t.artist, t.album, t.duration FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`),
  insert: db.prepare('INSERT INTO playlists (name) VALUES (?)'),
  rename: db.prepare('UPDATE playlists SET name = ? WHERE id = ?'),
  clear: db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?'),
  addTrack: db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) SELECT ?, id, ? FROM tracks WHERE id = ?'),
  remove: db.prepare('DELETE FROM playlists WHERE id = ?'),
};

export const listPlaylists = () => pq.all.all();

export function getPlaylist(id) {
  const playlist = pq.one.get(id);
  return playlist && { ...playlist, tracks: pq.tracks.all(id) };
}

function cleanName(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('A playlist needs a name.');
  if (clean.length > 80) throw new Error('The playlist name is too long (80 characters max).');
  return clean;
}

function setTracks(id, trackIds) {
  if (!Array.isArray(trackIds)) throw new Error('trackIds must be a list.');
  pq.clear.run(id);
  trackIds.forEach((trackId, position) => pq.addTrack.run(id, position, Number(trackId)));
}

function inTransaction(work) {
  db.exec('BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function createPlaylist(name, trackIds = []) {
  const clean = cleanName(name);
  return inTransaction(() => {
    const id = Number(pq.insert.run(clean).lastInsertRowid);
    setTracks(id, trackIds);
    return getPlaylist(id);
  });
}

/** Renames and/or replaces the tracks (in the given order). Returns undefined for an unknown playlist. */
export function updatePlaylist(id, name, trackIds) {
  if (!pq.one.get(id)) return undefined;
  const clean = cleanName(name);
  return inTransaction(() => {
    pq.rename.run(clean, id);
    if (trackIds !== undefined) setTracks(id, trackIds);
    return getPlaylist(id);
  });
}

export const deletePlaylist = id => pq.remove.run(id).changes > 0;
