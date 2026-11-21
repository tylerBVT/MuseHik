// Playlist API tests: a throw-away database and music folder, so the real library is never touched.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-pl-'));
const realConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const sample = readdirSync(realConfig.musicDir).filter(f => f.endsWith('.mp3')).slice(0, 3);
mkdirSync(join(tmp, 'music'));
sample.forEach((f, i) => copyFileSync(join(realConfig.musicDir, f), join(tmp, 'music', `s${i}.mp3`)));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json'); // the cloud index copy lives next to it

const { server } = await import('../server.mjs');
const { scanLibrary } = await import('../core/library.mjs');
let base;
let ids;

before(async () => {
  await scanLibrary();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  ids = (await (await fetch(`${base}/library`)).json()).map(t => t.id);
});
after(() => {
  server.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows keeps the SQLite file locked until exit; it is in the temp folder */ }
});

const call = (method, path, body) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});

test('the sample library has songs', () => assert.ok(ids.length >= 2));

test('create, read, list, update, delete a playlist', async () => {
  const created = await call('POST', '/playlists', { name: '  Road   trip ', trackIds: [ids[1], ids[0]] });
  assert.equal(created.status, 201);
  const playlist = await created.json();
  assert.equal(playlist.name, 'Road trip');
  assert.deepEqual(playlist.tracks.map(t => t.id), [ids[1], ids[0]]); // order kept

  const listed = await (await call('GET', '/playlists')).json();
  assert.deepEqual(listed.map(p => [p.name, p.count]), [['Road trip', 2]]);

  const updated = await (await call('PUT', `/playlists/${playlist.id}`, { name: 'Trip', trackIds: [ids[0]] })).json();
  assert.equal(updated.name, 'Trip');
  assert.deepEqual(updated.tracks.map(t => t.id), [ids[0]]);

  assert.equal((await call('DELETE', `/playlists/${playlist.id}`)).status, 200);
  assert.equal((await call('GET', `/playlists/${playlist.id}`)).status, 404);
  assert.equal((await (await call('GET', '/library')).json()).length, ids.length, 'songs survive playlist deletion');
});

test('rejects an empty name and ignores unknown or repeated songs', async () => {
  assert.equal((await call('POST', '/playlists', { name: '   ' })).status, 400);
  const made = await (await call('POST', '/playlists', { name: 'X', trackIds: [ids[0], ids[0], 999999] })).json();
  assert.deepEqual(made.tracks.map(t => t.id), [ids[0]]);
});

test('unknown playlist: 404 for read, update and delete', async () => {
  assert.equal((await call('GET', '/playlists/424242')).status, 404);
  assert.equal((await call('PUT', '/playlists/424242', { name: 'a' })).status, 404);
  assert.equal((await call('DELETE', '/playlists/424242')).status, 404);
});

test('a new playlist has a uid and is not shared', async () => {
  const made = await (await call('POST', '/playlists', { name: 'Fresh', trackIds: [ids[0]] })).json();
  assert.match(made.uid, /^[0-9a-f-]{36}$/);
  assert.equal(made.shared, false);
  const listed = (await (await call('GET', '/playlists')).json()).find(p => p.id === made.id);
  assert.equal(listed.uid, made.uid);
  assert.equal(listed.shared, false);
});

test('survives delete and re-download', async () => {
  const library = await (await call('GET', '/library')).json();
  const song = library[0];
  const made = await (await call('POST', '/playlists', { name: 'Keep me', trackIds: [song.id] })).json();
  const file = join(tmp, 'music', readdirSync(join(tmp, 'music')).find(f => f.endsWith('.mp3')));
  // The file disappears (deleted), then comes back as a new download: it gets a new library id.
  const away = join(tmp, 'away.mp3');
  renameSync(file, away);
  await call('POST', '/library/rescan');
  const gone = await (await call('GET', `/playlists/${made.id}`)).json();
  assert.equal(gone.tracks.length, 0, 'not playable while the file is gone');
  assert.equal(gone.songs.length, 1, 'but the song stays in the playlist');
  assert.equal(gone.songs[0].trackId, null);
  renameSync(away, join(tmp, 'music', 'redownloaded.mp3'));
  await call('POST', '/library/rescan');
  const back = await (await call('GET', `/playlists/${made.id}`)).json();
  assert.equal(back.tracks.length, 1);
  assert.notEqual(back.tracks[0].id, song.id, 'a new library id');
  assert.equal(back.tracks[0].title, song.title);
  ids = (await (await call('GET', '/library')).json()).map(t => t.id);
});

test('keeps identity refs on update', async () => {
  const ghost = { title: 'Ghost Song', artist: 'Nobody', album: '', duration: 100, isrc: null };
  const made = await (await call('POST', '/playlists', { name: 'Mixed', songs: [{ trackId: ids[0] }, ghost] })).json();
  assert.deepEqual(made.songs.map(s => s.title).slice(1), ['Ghost Song']);
  assert.equal(made.songs[1].trackId, null);
  assert.equal(made.songs[1].cloudId, null);
  assert.equal(made.tracks.length, 1, 'tracks = playable library songs only');
  const kept = made.songs[1];
  const updated = await (await call('PUT', `/playlists/${made.id}`, { name: 'Mixed', songs: [{ trackId: ids[1] }, kept] })).json();
  assert.deepEqual(updated.songs.map(s => s.title)[1], 'Ghost Song');
  assert.deepEqual(updated.tracks.map(t => t.id), [ids[1]]);
  assert.equal(updated.songs[0].trackId, ids[1]);
});

test('resolves cloud-only songs from the cloud index', async () => {
  writeFileSync(join(tmp, 'cloud-library.json'), JSON.stringify({ version: 1, nextId: 8, songs: [
    { id: 7, file: 'Sky - Cloud Only.mp3', title: 'Cloud Only', artist: 'Sky', album: '', duration: 200, isrc: null, key: 'sky|cloud only', size: 1 },
  ] }));
  const made = await (await call('POST', '/playlists', { name: 'From the cloud', songs: [{ cloudId: 7 }] })).json();
  assert.equal(made.songs.length, 1);
  assert.equal(made.songs[0].title, 'Cloud Only');
  assert.equal(made.songs[0].cloudId, 7);
  assert.equal(made.songs[0].trackId, null);
});
