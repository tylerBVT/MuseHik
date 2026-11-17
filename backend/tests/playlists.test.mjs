// Playlist API tests: a throw-away database and music folder, so the real library is never touched.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
