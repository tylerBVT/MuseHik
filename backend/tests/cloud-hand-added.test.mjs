// Songs put in music/songs/ with another tool (FileZilla...) show up in the app, and are never overwritten.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-hand-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { getUpload, startUpload } = await import('../modules/cloud/upload.mjs');

let ftp, base, songsDir;
before(async () => {
  ftp = await startFtp();
  const { host, port, user, password, allowPlainFtp } = ftp.settings;
  saveSettings({ host, port, user, password, allowPlainFtp });
  songsDir = join(ftp.root, 'music', 'songs');
  mkdirSync(songsDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await ftp.close(); });

const cloudSongs = async () => (await (await fetch(`${base}/songs`)).json()).songs;
const byFile = async file => (await cloudSongs()).find(s => s.file === file);

test('songs added by hand show up in the cloud list', async () => {
  writeFileSync(join(songsDir, 'Hand Artist - Hand Song.mp3'), Buffer.alloc(1000, 1));
  writeFileSync(join(songsDir, 'NoDash.mp3'), Buffer.alloc(500, 2));
  writeFileSync(join(songsDir, 'Half.part.mp3'), Buffer.alloc(10));
  writeFileSync(join(songsDir, 'notes.txt'), 'not a song');
  mkdirSync(join(songsDir, 'sub'));

  const songs = await cloudSongs();
  const hand = songs.find(s => s.file === 'Hand Artist - Hand Song.mp3');
  assert.ok(hand, 'the hand-added song is listed');
  assert.equal(hand.artist, 'Hand Artist');
  assert.equal(hand.title, 'Hand Song');
  assert.equal(hand.size, 1000);
  assert.equal(hand.addedBy, 'added by hand');
  assert.ok(!Number.isNaN(Date.parse(hand.addedAt)));
  const noDash = songs.find(s => s.file === 'NoDash.mp3');
  assert.equal(noDash.title, 'NoDash');
  assert.equal(noDash.artist, '');
  const files = songs.map(s => s.file);
  for (const ignored of ['Half.part.mp3', 'notes.txt', 'sub']) assert.equal(files.includes(ignored), false, ignored);
});

test('a song deleted by hand leaves the list', async () => {
  unlinkSync(join(songsDir, 'NoDash.mp3'));
  assert.equal(await byFile('NoDash.mp3'), undefined);
});

test('an empty listing never empties the list (a server glitch must not lose titles and dates)', async () => {
  const songsNow = (await cloudSongs()).length;
  assert.ok(songsNow > 0);
  const { renameSync } = await import('node:fs');
  renameSync(songsDir, `${songsDir}-away`); // the server answers "no songs" for a moment
  try {
    const during = await cloudSongs();
    assert.equal(during.length, songsNow);
  } finally {
    renameSync(`${songsDir}-away`, songsDir);
  }
  assert.equal((await cloudSongs()).length, songsNow);
});

test('when nothing changed the list file on the cloud is not rewritten', async () => {
  await cloudSongs();
  const listFile = join(ftp.root, 'music', 'library.json');
  const before = statSync(listFile).mtimeMs;
  await new Promise(r => setTimeout(r, 50));
  await cloudSongs();
  assert.equal(statSync(listFile).mtimeMs, before);
});

test('an upload never overwrites a song added by hand', async () => {
  writeFileSync(join(songsDir, 'Same - Name.mp3'), 'hand-made'); // the app has not listed the cloud since
  const local = join(tmp, 'Same - Name.mp3');
  writeFileSync(local, makeMp3({ title: 'Name', artist: 'Same' }));
  const job = startUpload({ paths: [local] }, ftp.settings);
  for (let i = 0; i < 400 && getUpload(job.id).state === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  const done = getUpload(job.id);
  assert.equal(done.state, 'done');
  assert.equal(done.failed.length, 0);
  assert.equal(readFileSync(join(songsDir, 'Same - Name.mp3'), 'utf8'), 'hand-made');
});

test('playing a song added by hand fills in its title, artist and length from its tags', async () => {
  writeFileSync(join(songsDir, 'whatever.mp3'), makeMp3({ title: 'Tagged Title', artist: 'Tagged Artist', seconds: 3 }));
  const before = await byFile('whatever.mp3');
  assert.equal(before.title, 'whatever');
  assert.equal(before.duration, 0);

  const response = await fetch(`${base}/songs/${before.id}/stream`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  let after;
  for (let i = 0; i < 40; i++) { // the tags are written right after the download, while the song plays
    after = await byFile('whatever.mp3');
    if (after.duration) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(after.id, before.id);
  assert.equal(after.title, 'Tagged Title');
  assert.equal(after.artist, 'Tagged Artist');
  assert.ok(Math.abs(after.duration - 3) < 0.2, String(after.duration));
});
