// Settings > Music folder and Settings > Who uses this laptop: the /api/app routes (modules/app).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-folder-'));
process.env.MUSEHIK_DATA_DIR = join(tmp, 'data');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.MUSEHIK_TRASH = 'delete';
delete process.env.MUSIC_DIR;
const { saveAppSettings, musicDir } = await import('../core/config.mjs');
const { addFile, listTracks, scanLibrary } = await import('../core/library.mjs');
const { createPlaylist, getPlaylist } = await import('../modules/musicPlayer/playlists.mjs');
const folder = await import('../modules/app/musicFolder.mjs');
const { server } = await import('../server.mjs');

let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/app`;
});
after(() => server.close());

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

let n = 0;
/** A fresh pair of folders (with a space and an accent in the names), the old one set as the music folder. */
async function folders() {
  n++;
  const from = join(tmp, `Ma musique ${n}`);
  const to = join(tmp, `Mütti music ${n}`);
  mkdirSync(from);
  mkdirSync(to);
  saveAppSettings({ musicDir: from });
  await scanLibrary();
  return { from, to };
}
async function song(dir, name, title, artist = 'Artist') {
  const path = join(dir, `${name}.mp3`);
  writeFileSync(path, makeMp3({ title, artist }));
  await addFile(path);
  return listTracks().find(t => t.title === title);
}

beforeEach(() => {
  folder.setRename(null);
  folder.setBusyCheck(null);
});

test('GET /api/app reports profile, folder and song count', async () => {
  const { from } = await folders();
  await song(from, 'one', 'Count One');
  const { status, body } = await api('');
  assert.equal(status, 200);
  assert.equal(body.profile, 'poontje');
  assert.equal(body.musicDir, from);
  assert.equal(body.songs, 1);
  assert.equal(body.installed, false);
  assert.equal(body.version, null);
});

test('move: files land in the new folder, ids and added dates are kept, a playlist still lists them', async () => {
  const { from, to } = await folders();
  const a = await song(from, 'Artist - Song A', 'Song A');
  mkdirSync(join(from, 'Sub'));
  const b = await song(join(from, 'Sub'), 'Artist - Song B', 'Song B');
  const playlist = createPlaylist('Folder test', [a.id, b.id]);

  const { status, body } = await api('/music-folder', { method: 'POST', body: { path: to, move: true } });
  assert.equal(status, 200);
  assert.deepEqual(body, { musicDir: to, moved: 2, failed: [], total: 2 });
  assert.equal(musicDir(), to);
  assert.ok(existsSync(join(to, 'Artist - Song A.mp3')));
  assert.ok(existsSync(join(to, 'Sub', 'Artist - Song B.mp3')), 'subfolders are kept');
  assert.equal(existsSync(join(from, 'Artist - Song A.mp3')), false);
  const after = listTracks();
  assert.equal(after.find(t => t.title === 'Song A').id, a.id);
  assert.equal(after.find(t => t.title === 'Song A').addedAt, a.addedAt);
  assert.deepEqual(getPlaylist(playlist.id).tracks.map(t => t.id), [a.id, b.id]);
});

test('move: a name clash gets a free name, nothing is overwritten', async () => {
  const { from, to } = await folders();
  await song(from, 'Same', 'Moving');
  writeFileSync(join(to, 'Same.mp3'), makeMp3({ title: 'Already there', artist: 'X' }));
  const { body } = await api('/music-folder', { method: 'POST', body: { path: to, move: true } });
  assert.equal(body.moved, 1);
  assert.deepEqual(readdirSync(to).sort(), ['Same (2).mp3', 'Same.mp3']);
  assert.deepEqual(listTracks().map(t => t.title).sort(), ['Already there', 'Moving']);
});

test('moves across devices', async () => {
  const { from, to } = await folders();
  const a = await song(from, 'Far', 'Far Away');
  folder.setRename(async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); });
  const { body } = await api('/music-folder', { method: 'POST', body: { path: to, move: true } });
  assert.equal(body.moved, 1);
  assert.ok(existsSync(join(to, 'Far.mp3')));
  assert.equal(existsSync(join(from, 'Far.mp3')), false);
  assert.equal(listTracks().find(t => t.title === 'Far Away').id, a.id);
});

test('use as it is: old songs leave the library, songs already in the new folder appear', async () => {
  const { from, to } = await folders();
  await song(from, 'Old', 'Old Song');
  writeFileSync(join(to, 'New.mp3'), makeMp3({ title: 'New Song', artist: 'Y' }));
  const { status, body } = await api('/music-folder', { method: 'POST', body: { path: to, move: false } });
  assert.equal(status, 200);
  assert.equal(body.moved, 0);
  assert.deepEqual(listTracks().map(t => t.title), ['New Song']);
  assert.ok(existsSync(join(from, 'Old.mp3')), 'nothing is deleted');
});

test('refused while a download runs', async () => {
  const { to } = await folders();
  folder.setBusyCheck(() => true);
  const { status, body } = await api('/music-folder', { method: 'POST', body: { path: to, move: true } });
  assert.equal(status, 409);
  assert.equal(body.error, 'Wait until the download, upload or separation is finished.');
});

test('refused: same folder, missing folder, a folder inside the current one, the current one inside it', async () => {
  const { from } = await folders();
  mkdirSync(join(from, 'inner'));
  for (const path of [from, from.toUpperCase(), join(tmp, 'does not exist'), join(from, 'inner'), tmp, 'relative']) {
    const { status } = await api('/music-folder', { method: 'POST', body: { path, move: true } });
    assert.equal(status, 400, path);
  }
  assert.equal(musicDir(), from);
});

test('PUT /api/app/profile switches profile; unknown profile is 400', async () => {
  let r = await api('/profile', { method: 'PUT', body: { profile: 'muttmutt' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile, 'muttmutt');
  r = await api('/profile', { method: 'PUT', body: { profile: 'nobody' } });
  assert.equal(r.status, 400);
  assert.equal((await api('')).body.profile, 'muttmutt');
  await api('/profile', { method: 'PUT', body: { profile: 'poontje' } });
});
