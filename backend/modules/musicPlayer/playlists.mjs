// Playlists: a name plus an ordered list of library tracks. Deleting a playlist never deletes songs.
// Stored in the shared library database, next to the tracks they point to.
import { db } from '../../core/library.mjs';

db.exec(`
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
