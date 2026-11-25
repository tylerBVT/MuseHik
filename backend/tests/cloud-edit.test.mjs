// The ⋮ menu on cloud songs: rename (the cloud file follows), genre (kept in the shared list), offline refusal.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-cloud-edit-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { createPlaylist, getPlaylist } = await import('../modules/musicPlayer/playlists.mjs');

let remote, base;
const songsDir = () => join(remote.root, 'music', 'songs');
const index = () => JSON.parse(readFileSync(join(remote.root, 'music', 'library.json'), 'utf8'));
before(async () => {
  remote = await startCloud();
  
  saveSettings({ ...remote.settings });
  mkdirSync(songsDir(), { recursive: true });
  for (const name of ['Mum - First', 'Mum - Second', 'Taken - Name']) writeFileSync(join(songsDir(), `${name}.mp3`), Buffer.alloc(100));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await remote.close(); });

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const songNamed = async file => (await api('/songs')).body.songs.find(s => s.file === file);

test('rename: the list entry and the cloud file follow, same id', async () => {
  const song = await songNamed('Mum - First.mp3');
  const { status, body } = await api(`/songs/${song.id}`, { method: 'PATCH', body: { title: 'Premier', genre: 'Pop' } });
  assert.equal(status, 200);
  assert.equal(body.id, song.id);
  assert.equal(body.title, 'Premier');
  assert.equal(body.genre, 'Pop');
  assert.equal(body.file, 'Mum - Premier.mp3');
  assert.ok(existsSync(join(songsDir(), 'Mum - Premier.mp3')));
  assert.equal(existsSync(join(songsDir(), 'Mum - First.mp3')), false);
  const entry = index().songs.find(s => s.id === song.id);
  assert.equal(entry.file, 'Mum - Premier.mp3');
  assert.equal(entry.key, 'mum|premier');
});

test('genre only: the file keeps its name', async () => {
  const song = await songNamed('Mum - Second.mp3');
  const { body } = await api(`/songs/${song.id}`, { method: 'PATCH', body: { genre: 'Rock' } });
  assert.equal(body.genre, 'Rock');
  assert.equal(body.file, 'Mum - Second.mp3');
});

test('a name another cloud file has: never overwritten', async () => {
  const song = await songNamed('Mum - Second.mp3');
  const { body } = await api(`/songs/${song.id}`, { method: 'PATCH', body: { artist: 'Taken', title: 'Name' } });
  assert.equal(body.file, 'Taken - Name (2).mp3');
  assert.ok(existsSync(join(songsDir(), 'Taken - Name.mp3')), 'the other file is untouched');
});

test('a playlist keeps a renamed cloud song', async () => {
  const song = await songNamed('Mum - Premier.mp3');
  const playlist = createPlaylist('Cloud list', [{ cloudId: song.id }]);
  await api(`/songs/${song.id}`, { method: 'PATCH', body: { title: 'Premier (live)' } });
  const [entry] = getPlaylist(playlist.id).songs;
  assert.equal(entry.title, 'Premier (live)');
  assert.equal(entry.cloudId, song.id);
});

test('an empty title is refused, an unknown song is 404', async () => {
  const song = await songNamed('Taken - Name.mp3');
  assert.equal((await api(`/songs/${song.id}`, { method: 'PATCH', body: { title: '' } })).status, 400);
  assert.equal((await api('/songs/9999', { method: 'PATCH', body: { title: 'X' } })).status, 404);
});

test('offline: refused without connecting', async () => {
  const song = await songNamed('Taken - Name.mp3');
  saveSettings({ online: false });
  const logins = remote.requests;
  const { status, body } = await api(`/songs/${song.id}`, { method: 'PATCH', body: { genre: 'X' } });
  assert.equal(status, 400);
  assert.match(body.error, /offline/);
  assert.equal(remote.requests, logins);
  saveSettings({ online: true });
});
