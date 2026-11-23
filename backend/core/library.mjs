// Library index (idea from Harmony: a SQLite index is the source of truth, the folder is only reconciled
// into it). Uses Node's built-in SQLite, so no database dependency.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseFile } from 'music-metadata';
import { dataDir, musicDir } from './config.mjs';
import { AUDIO_EXTS, fileBase, sameLength, sameSong, trackKey } from './lib.mjs';
import { moveToTrash, writeTags } from './tags.mjs';

export { AUDIO_EXTS };

mkdirSync(dataDir, { recursive: true });
/** The one SQLite database. Modules add their own tables to it (see modules/musicPlayer/playlists.mjs). */
export const db = new DatabaseSync(process.env.LIBRARY_DB || join(dataDir, 'library.db'));
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
`);
// added_ms: when the file appeared on this laptop (its creation time), i.e. the download date. Kept when the file
// is read again; filled in for songs indexed before it existed.
const trackColumns = new Set(db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name));
if (!trackColumns.has('added_ms')) db.exec('ALTER TABLE tracks ADD COLUMN added_ms INTEGER');
// genre: from the file's tags (set in the song menu). Songs indexed before it existed are read again at the next scan.
if (!trackColumns.has('genre')) {
  db.exec("ALTER TABLE tracks ADD COLUMN genre TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE tracks SET mtime_ms = -1');
}

const q = {
  byPath: db.prepare('SELECT * FROM tracks WHERE path = ?'),
  byId: db.prepare('SELECT * FROM tracks WHERE id = ?'),
  byIsrc: db.prepare('SELECT * FROM tracks WHERE isrc = ? COLLATE NOCASE'),
  bySource: db.prepare('SELECT * FROM tracks WHERE source = ?'),
  byKey: db.prepare('SELECT * FROM tracks WHERE key = ?'),
  byDuration: db.prepare('SELECT * FROM tracks WHERE duration BETWEEN ? AND ?'),
  upsert: db.prepare(`
    INSERT INTO tracks (path, title, artist, album, genre, duration, isrc, key, source, size, mtime_ms, added_ms)
    VALUES (@path, @title, @artist, @album, @genre, @duration, @isrc, @key, @source, @size, @mtime_ms, @added_ms)
    ON CONFLICT(path) DO UPDATE SET title=@title, artist=@artist, album=@album, genre=@genre, duration=@duration,
      isrc=@isrc, key=@key, source=COALESCE(@source, source), size=@size, mtime_ms=@mtime_ms,
      added_ms=COALESCE(added_ms, @added_ms)`),
  setAdded: db.prepare('UPDATE tracks SET added_ms = ? WHERE path = ?'),
  edit: db.prepare(`UPDATE tracks SET path=@path, title=@title, artist=@artist, genre=@genre, key=@key, size=@size,
    mtime_ms=@mtime_ms WHERE id=@id`),
  removeId: db.prepare('DELETE FROM tracks WHERE id = ?'),
  listedById: db.prepare('SELECT id, title, artist, album, genre, duration, size, added_ms FROM tracks WHERE id = ?'),
  remove: db.prepare('DELETE FROM tracks WHERE path = ?'),
  all: db.prepare('SELECT id, title, artist, album, genre, duration, size, added_ms FROM tracks ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE'),
  paths: db.prepare('SELECT path, size, mtime_ms, added_ms FROM tracks'),
  count: db.prepare('SELECT COUNT(*) AS n FROM tracks'),
};

/** Title, artist, length... of an audio file (falls back to the file name when it has no tags). */
export async function readTags(path) {
  const info = await stat(path);
  let meta = null;
  try { meta = await parseFile(path, { duration: true, skipCovers: true }); } catch { /* unreadable tags: fall back to the file name */ }
  const common = meta?.common ?? {};
  const fallback = basename(path, extname(path));
  const title = common.title || fallback;
  const artist = common.artist || '';
  return {
    path, title, artist, album: common.album || '', genre: common.genre?.[0] || '',
    duration: meta?.format?.duration || 0,
    isrc: common.isrc?.[0] || null,
    key: trackKey(artist, title),
    size: info.size, mtime_ms: Math.floor(info.mtimeMs),
    added_ms: Math.floor(info.birthtimeMs || info.mtimeMs),
  };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    // "*.part.mp3" = a file still being written (e.g. an instrumental in the making): not a song yet.
    else if (AUDIO_EXTS.has(extname(entry.name).toLowerCase()) && !/\.part\.\w+$/i.test(entry.name)) yield full;
  }
}

/** Reconciles the folder with the index: parses new/changed files, forgets deleted ones. */
export async function scanLibrary() {
  const known = new Map(q.paths.all().map(r => [r.path, r]));
  let added = 0;
  try {
    for await (const path of walk(musicDir())) {
      const old = known.get(path);
      known.delete(path);
      const info = await stat(path);
      if (old && old.size === info.size && old.mtime_ms === Math.floor(info.mtimeMs)) {
        if (old.added_ms == null) q.setAdded.run(Math.floor(info.birthtimeMs || info.mtimeMs), path);
        continue;
      }
      q.upsert.run({ source: null, ...(await readTags(path)) });
      added++;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // music folder not created yet = empty library
  }
  for (const path of known.keys()) q.remove.run(path);
  return { added, removed: known.size, total: q.count.get().n };
}

/** Removes a deleted file from the index. */
export function forgetFile(path) {
  q.remove.run(path);
}

/** Registers one freshly written file (keeps the platform source id, e.g. "youtube:abc"). */
export async function addFile(path, source = null) {
  q.upsert.run({ ...(await readTags(path)), source });
}

/**
 * Is this song already in the library? Checks, in order: ISRC, source id, the cleaned-up artist+title key
 * with a compatible duration, then (when the duration is known) the same recording uploaded differently
 * (see sameSong). `exceptPath` ignores one file (the one just downloaded). Returns the existing row or undefined.
 */
export function findDuplicate({ title, artist, duration, isrc, source }, exceptPath) {
  const other = r => r && r.path !== exceptPath;
  // `matchedBy` says why it counts as the same song (shown in download reports, to spot wrong matches).
  const found = (row, matchedBy) => (row ? { ...row, matchedBy } : undefined);
  if (isrc) { const hit = q.byIsrc.all(isrc).find(other); if (hit) return found(hit, 'same ISRC'); }
  if (source) { const hit = q.bySource.all(source).find(other); if (hit) return found(hit, 'same YouTube video'); }
  if (!title) return undefined;
  const exact = q.byKey.all(trackKey(artist, title)).find(r => other(r) && sameLength(r.duration, duration));
  if (exact || !duration) return found(exact, 'same artist + title');
  return found(q.byDuration.all(duration - 5, duration + 5).find(r => other(r) && sameSong(r, { title, artist, duration })),
    'another upload (same title, artist and length)');
}

/** For a file just written: the library song it duplicates (judged by its own tags), or undefined. */
export async function duplicateOfFile(path) {
  const tags = await readTags(path);
  return findDuplicate(tags, path);
}

const listed = ({ added_ms, ...track }) => ({ ...track, addedAt: added_ms == null ? null : new Date(added_ms).toISOString() });
/** Every song, with `addedAt`: when its file appeared on this laptop (ISO date, or null when unknown). */
export const listTracks = () => q.all.all().map(listed);
export const getTrack = id => q.byId.get(id);
export const hasPath = path => Boolean(q.byPath.get(path));

/** "<base><ext>" in `dir`, or "<base> (2)<ext>"... if taken (`own`: the song's current file, never "taken"). */
export function freePath(dir, base, ext, own = null) {
  const mine = p => own && p.toLowerCase() === own.toLowerCase();
  let path = join(dir, `${base}${ext}`);
  for (let n = 2; existsSync(path) && !mine(path); n++) path = join(dir, `${base} (${n})${ext}`);
  return path;
}

/**
 * The song menu's Save: writes title, artist and genre into the file, and renames it "Artist - Title" when they
 * changed (never over another file). Same row, so the id and the download date stay. Returns the song as listed.
 */
export async function editTrack(id, { title, artist, genre } = {}) {
  const track = getTrack(id);
  if (!track) return null;
  const next = {
    title: String(title ?? track.title).trim(),
    artist: String(artist ?? track.artist).trim(),
    genre: String(genre ?? track.genre ?? '').trim(),
  };
  if (!next.title) throw new Error('A song needs a title.');
  if (next.title.length > 200 || next.artist.length > 200 || next.genre.length > 60) throw new Error('That is too long.');
  await writeTags(track.path, next);
  let path = track.path;
  if (next.title !== track.title || next.artist !== track.artist) {
    const ext = extname(path);
    path = freePath(dirname(path), fileBase(next.artist, next.title), ext, track.path);
    if (path !== track.path) await rename(track.path, path);
  }
  const info = await stat(path);
  q.edit.run({ id, path, ...next, key: trackKey(next.artist, next.title), size: info.size, mtime_ms: Math.floor(info.mtimeMs) });
  return listed(q.listedById.get(id));
}

/** The song menu's Delete: the file goes to the Recycle Bin, the song leaves the list. False if unknown. */
export async function deleteTrack(id) {
  const track = getTrack(id);
  if (!track) return false;
  if (existsSync(track.path)) await moveToTrash(track.path);
  q.removeId.run(id);
  return true;
}

/** Embedded cover art of a file, or null. */
export async function coverOf(path) {
  try {
    const meta = await parseFile(path, { skipCovers: false });
    const picture = meta.common.picture?.[0];
    return picture ? { data: Buffer.from(picture.data), type: picture.format || 'image/jpeg' } : null;
  } catch { return null; }
}
