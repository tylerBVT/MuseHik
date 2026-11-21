// Playlists: a name plus an ordered list of songs. Deleting a playlist never deletes songs.
// Songs are stored by IDENTITY (title, artist, album, length, ISRC), not by this laptop's library numbers, so a
// playlist survives a song being deleted and downloaded again, and means the same thing on another laptop.
// Each song is matched when the playlist is read: this laptop's library first, then the cloud, else "unavailable".
// A shared playlist also lives on the cloud (see modules/cloud/playlistSync.mjs): `uid` names it on every laptop,
// `updated_at` decides which side is newer, and deleting a shared one leaves a tombstone so the delete travels too.
import { randomUUID } from 'node:crypto';
import { findDuplicate, getTrack, db } from '../../core/library.mjs';
import { sameIdentity, trackKey } from '../../core/lib.mjs';
import { lastIndex } from '../cloud/store.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    isrc TEXT,
    key TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
  );
  CREATE TABLE IF NOT EXISTS playlist_tombstones (uid TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
`);

// Columns added for sharing (older databases have only id, name, created_at).
const columns = new Set(db.prepare('PRAGMA table_info(playlists)').all().map(c => c.name));
if (!columns.has('uid')) db.exec('ALTER TABLE playlists ADD COLUMN uid TEXT');
if (!columns.has('shared')) db.exec('ALTER TABLE playlists ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
if (!columns.has('owner')) db.exec("ALTER TABLE playlists ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
if (!columns.has('updated_at')) db.exec('ALTER TABLE playlists ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
for (const { id } of db.prepare('SELECT id FROM playlists WHERE uid IS NULL').all()) {
  db.prepare('UPDATE playlists SET uid = ?, updated_at = ? WHERE id = ?').run(randomUUID(), Date.now(), id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS playlists_uid ON playlists(uid)');

// One-off: playlists saved the old way (playlist_tracks = library numbers) become identity rows, in order.
if (!db.prepare("SELECT 1 FROM migrations WHERE name = 'playlist_songs'").get()) {
  const old = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'playlist_tracks'").get();
  if (old) {
    db.exec(`INSERT OR IGNORE INTO playlist_songs (playlist_id, position, title, artist, album, duration, isrc, key)
      SELECT pt.playlist_id, pt.position, t.title, t.artist, t.album, t.duration, t.isrc, t.key
      FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id`);
  }
  db.exec("INSERT INTO migrations (name) VALUES ('playlist_songs')");
}

const pq = {
  all: db.prepare(`SELECT p.id, p.uid, p.name, p.shared, p.owner, p.updated_at, COUNT(s.position) AS count
    FROM playlists p LEFT JOIN playlist_songs s ON s.playlist_id = p.id GROUP BY p.id ORDER BY p.name COLLATE NOCASE`),
  one: db.prepare('SELECT id, uid, name, shared, owner, updated_at FROM playlists WHERE id = ?'),
  byUid: db.prepare('SELECT id, uid, name, shared, owner, updated_at FROM playlists WHERE uid = ?'),
  rows: db.prepare('SELECT id, uid, name, shared, owner, updated_at FROM playlists'),
  songs: db.prepare('SELECT title, artist, album, duration, isrc, key FROM playlist_songs WHERE playlist_id = ? ORDER BY position'),
  insert: db.prepare('INSERT INTO playlists (name, uid, shared, owner, updated_at) VALUES (?, ?, ?, ?, ?)'),
  rename: db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?'),
  share: db.prepare('UPDATE playlists SET shared = ?, owner = ?, updated_at = ? WHERE id = ?'),
  fromCloud: db.prepare('UPDATE playlists SET name = ?, owner = ?, shared = 1, updated_at = ? WHERE id = ?'),
  clear: db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?'),
  addSong: db.prepare(`INSERT INTO playlist_songs (playlist_id, position, title, artist, album, duration, isrc, key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  remove: db.prepare('DELETE FROM playlists WHERE id = ?'),
  tomb: db.prepare('INSERT OR REPLACE INTO playlist_tombstones (uid, deleted_at) VALUES (?, ?)'),
  tombs: db.prepare('SELECT uid, deleted_at AS deletedAt FROM playlist_tombstones'),
  untomb: db.prepare('DELETE FROM playlist_tombstones WHERE uid = ?'),
};

// Strictly increasing "now": two changes in the same millisecond still have an order.
let lastTick = 0;
const now = () => (lastTick = Math.max(lastTick + 1, Date.now()));

const listeners = new Set();
/** Called (with the playlist uid) after any change that the cloud should hear about. */
export const onSharedChange = fn => listeners.add(fn);
const changed = uid => listeners.forEach(fn => { try { fn(uid); } catch (e) { console.error(e); } });

const identity = s => ({
  title: String(s.title ?? '').trim(), artist: String(s.artist ?? ''), album: String(s.album ?? ''),
  duration: Number(s.duration) || 0, isrc: s.isrc || null, key: trackKey(s.artist ?? '', s.title ?? ''),
});
const cloudSongs = () => lastIndex()?.songs ?? [];

/** Where a song of a playlist plays from: library song id, cloud song id, or neither. */
function resolve(song) {
  const local = findDuplicate({ title: song.title, artist: song.artist, duration: song.duration, isrc: song.isrc });
  const cloud = local ? null : cloudSongs().find(c => sameIdentity(c, song));
  return { trackId: local?.id ?? null, cloudId: cloud?.id ?? null, local };
}

/** A song reference from the API: { trackId } (library), { cloudId } (cloud index), a number, or an identity. */
function toIdentity(ref) {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) ref = { trackId: Number(ref) };
  if (ref?.trackId != null) {
    const t = getTrack(Number(ref.trackId));
    return t ? identity(t) : null;
  }
  if (ref?.cloudId != null) {
    const c = cloudSongs().find(s => s.id === Number(ref.cloudId));
    return c ? identity(c) : null;
  }
  return ref?.title ? identity(ref) : null;
}

const summary = row => ({ id: row.id, uid: row.uid, name: row.name, shared: Boolean(row.shared), owner: row.owner, updatedAt: row.updated_at });

export const listPlaylists = () => pq.all.all().map(row => ({ ...summary(row), count: row.count }));

/** The playlist with its songs resolved; `tracks` keeps only the songs playable from this laptop's library. */
export function getPlaylist(id) {
  const row = pq.one.get(id);
  if (!row) return undefined;
  const songs = [];
  const tracks = [];
  for (const song of pq.songs.all(id)) {
    const { trackId, cloudId, local } = resolve(song);
    songs.push({ ...song, trackId, cloudId });
    if (local) tracks.push({ id: local.id, title: local.title, artist: local.artist, album: local.album, duration: local.duration, size: local.size });
  }
  return { ...summary(row), songs, tracks };
}

function cleanName(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('A playlist needs a name.');
  if (clean.length > 80) throw new Error('The playlist name is too long (80 characters max).');
  return clean;
}

/** Replaces the songs. Unknown references and repeated songs are dropped. */
function setSongs(id, refs) {
  if (!Array.isArray(refs)) throw new Error('The songs must be a list.');
  const kept = [];
  for (const ref of refs) {
    const song = toIdentity(ref);
    if (song?.title && !kept.some(k => sameIdentity(k, song))) kept.push(song);
  }
  pq.clear.run(id);
  kept.forEach((s, position) => pq.addSong.run(id, position, s.title, s.artist, s.album, s.duration, s.isrc, s.key));
}

function inTransaction(work) {
  db.exec('BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function createPlaylist(name, refs = []) {
  const clean = cleanName(name);
  return inTransaction(() => {
    const id = Number(pq.insert.run(clean, randomUUID(), 0, '', now()).lastInsertRowid);
    setSongs(id, refs);
    return getPlaylist(id);
  });
}

/** Renames and/or replaces the songs (in the given order). Returns undefined for an unknown playlist. */
export function updatePlaylist(id, name, refs) {
  const row = pq.one.get(id);
  if (!row) return undefined;
  const clean = cleanName(name);
  const result = inTransaction(() => {
    pq.rename.run(clean, now(), id);
    if (refs !== undefined) setSongs(id, refs);
    return getPlaylist(id);
  });
  if (row.shared) changed(row.uid);
  return result;
}

export function deletePlaylist(id) {
  const row = pq.one.get(id);
  if (!row) return false;
  pq.remove.run(id);
  if (row.shared) {
    pq.tomb.run(row.uid, now());
    changed(row.uid);
  }
  return true;
}

/** Turns sharing on or off. `owner` is the name shown on the other laptop. */
export function setShared(id, shared, owner = '') {
  const row = pq.one.get(id);
  if (!row) return undefined;
  pq.share.run(shared ? 1 : 0, shared ? (row.owner || owner) : row.owner, now(), id);
  changed(row.uid);
  return getPlaylist(id);
}

// ---- For the cloud sync -------------------------------------------------------------------------------------

/** Every playlist with its songs as identities (no resolution). */
export const playlistRows = () => pq.rows.all().map(row => ({ ...summary(row), songs: pq.songs.all(row.id) }));
export const playlistByUid = uid => {
  const row = pq.byUid.get(uid);
  return row && { ...summary(row), songs: pq.songs.all(row.id) };
};
export const tombstones = () => pq.tombs.all();
export const clearTombstone = uid => pq.untomb.run(uid);

/** Stores a playlist received from the cloud (creates or replaces it; it stays shared). No change event. */
export function upsertFromCloud({ uid, name, owner, updatedAt, songs }) {
  return inTransaction(() => {
    let row = pq.byUid.get(uid);
    if (row) pq.fromCloud.run(name, owner || '', updatedAt, row.id);
    else row = { id: Number(pq.insert.run(name, uid, 1, owner || '', updatedAt).lastInsertRowid) };
    pq.clear.run(row.id);
    songs.map(identity).forEach((s, position) => pq.addSong.run(row.id, position, s.title, s.artist, s.album, s.duration, s.isrc, s.key));
    return row.id;
  });
}

/** Removes a playlist because the cloud says it was deleted or unshared. No tombstone, no change event. */
export function removeByUid(uid) {
  const row = pq.byUid.get(uid);
  if (row) pq.remove.run(row.id);
}
