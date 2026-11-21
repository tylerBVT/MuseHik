// Upgrading: playlists saved the old way (local song numbers in playlist_tracks) are converted once, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-migrate-'));
const realConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
mkdirSync(join(tmp, 'music'));
readdirSync(realConfig.musicDir).filter(f => f.endsWith('.mp3')).slice(0, 3)
  .forEach((f, i) => copyFileSync(join(realConfig.musicDir, f), join(tmp, 'music', `s${i}.mp3`)));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'old.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');

const { db, listTracks, scanLibrary } = await import('../core/library.mjs');
await scanLibrary();
const [a, b, c] = listTracks();
// The old layout, exactly as the previous version created it.
db.exec(`
  CREATE TABLE playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE playlist_tracks (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY (playlist_id, track_id));
  INSERT INTO playlists (id, name) VALUES (1, 'Old one');
`);
db.prepare('INSERT INTO playlist_tracks VALUES (1, ?, 0), (1, ?, 1), (1, ?, 2)').run(c.id, a.id, b.id);

const { getPlaylist, listPlaylists } = await import('../modules/musicPlayer/playlists.mjs');

test('migrates old playlists in order', () => {
  const playlist = getPlaylist(1);
  assert.equal(playlist.name, 'Old one');
  assert.deepEqual(playlist.songs.map(s => s.title), [c.title, a.title, b.title]);
  assert.deepEqual(playlist.tracks.map(t => t.id), [c.id, a.id, b.id]);
  assert.match(playlist.uid, /^[0-9a-f-]{36}$/);
  assert.equal(listPlaylists()[0].count, 3);
});
