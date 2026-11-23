// The ⋮ menu on library songs: rename (title, artist), genre, delete. Tags are written into the file with ffmpeg.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-edit-'));
const music = join(tmp, 'music');
mkdirSync(music);
process.env.MUSIC_DIR = music;
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.MUSEHIK_TRASH = 'delete'; // tests: delete for real instead of filling the Recycle Bin
const { ffmpeg } = await import('../core/config.mjs');
const { addFile, getTrack, listTracks } = await import('../core/library.mjs');
const { createPlaylist, getPlaylist } = await import('../modules/musicPlayer/playlists.mjs');
const { server } = await import('../server.mjs');

const skip = existsSync(ffmpeg) ? false : 'ffmpeg is not installed';
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/library`;
});
after(() => server.close());

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function song(name, title, artist) {
  const path = join(music, `${name}.mp3`);
  writeFileSync(path, makeMp3({ title, artist }));
  await addFile(path);
  return listTracks().find(t => t.title === title);
}

test('rename and genre: written into the file, file renamed, same song kept', { skip }, async () => {
  const track = await song('old name', 'Old Title', 'Old Artist');
  const { status, body } = await api(`/${track.id}`, {
    method: 'PATCH', body: { title: 'New Title', artist: 'New Artist', genre: 'Rap' },
  });
  assert.equal(status, 200);
  assert.equal(body.id, track.id, 'same id: playlists and history keep pointing at it');
  assert.equal(body.addedAt, track.addedAt, 'the download date is kept');
  assert.equal(body.genre, 'Rap');
  const path = join(music, 'New Artist - New Title.mp3');
  assert.equal(getTrack(track.id).path, path);
  assert.equal(existsSync(join(music, 'old name.mp3')), false);
  const { common } = await parseFile(path);
  assert.equal(common.title, 'New Title');
  assert.equal(common.artist, 'New Artist');
  assert.deepEqual(common.genre, ['Rap']);
});

test('genre only: the file name stays', { skip }, async () => {
  const track = await song('Keep - Name', 'Name', 'Keep');
  const { body } = await api(`/${track.id}`, { method: 'PATCH', body: { genre: 'Jazz' } });
  assert.equal(body.genre, 'Jazz');
  assert.equal(body.title, 'Name');
  assert.equal(getTrack(track.id).path, join(music, 'Keep - Name.mp3'));
});

test('a name another file has: never overwritten', { skip }, async () => {
  await song('Same - Name', 'Name', 'Same');
  const other = await song('different', 'Other', 'Same');
  const { body } = await api(`/${other.id}`, { method: 'PATCH', body: { title: 'Name' } });
  assert.equal(getTrack(body.id).path, join(music, 'Same - Name (2).mp3'));
  assert.ok(existsSync(join(music, 'Same - Name.mp3')), 'the first one is still there');
});

test('a playlist keeps playing a renamed song', { skip }, async () => {
  const track = await song('In - List', 'List', 'In');
  const playlist = createPlaylist('Mine', [{ trackId: track.id }]);
  await api(`/${track.id}`, { method: 'PATCH', body: { title: 'Listed' } });
  const songs = getPlaylist(playlist.id).songs;
  assert.equal(songs[0].title, 'Listed');
  assert.equal(songs[0].trackId, track.id);
});

test('an empty title is refused', { skip }, async () => {
  const track = await song('No - Title', 'Title', 'No');
  const { status, body } = await api(`/${track.id}`, { method: 'PATCH', body: { title: '  ' } });
  assert.equal(status, 400);
  assert.match(body.error, /title/i);
});

test('delete: the file leaves the folder and the list', async () => {
  const track = await song('Gone - Song', 'Song', 'Gone');
  assert.equal((await api(`/${track.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(readdirSync(music).includes('Gone - Song.mp3'), false);
  assert.equal(getTrack(track.id), undefined);
  assert.equal((await api(`/${track.id}`, { method: 'DELETE' })).status, 404);
});
