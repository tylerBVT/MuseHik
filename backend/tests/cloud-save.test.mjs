// "Download from cloud": cloud songs copied into this laptop's music folder and library.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import { startFtp } from './ftp-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-save-'));
const music = join(tmp, 'music');
mkdirSync(music);
process.env.MUSIC_DIR = music;
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { fetchSong } = await import('../modules/cloud/cache.mjs');
const { listTracks } = await import('../core/library.mjs');

let ftp, base;
const songsDir = () => join(ftp.root, 'music', 'songs');
before(async () => {
  ftp = await startFtp({ slow: { pattern: /Slow/, chunk: 20_000, delayMs: 50 } });
  const { host, port, user, password, allowPlainFtp } = ftp.settings;
  saveSettings({ host, port, user, password, allowPlainFtp });
  mkdirSync(songsDir(), { recursive: true });
  writeFileSync(join(songsDir(), 'Mum - Song.mp3'), makeMp3({ title: 'Wrong tag', artist: 'Wrong' }));
  writeFileSync(join(songsDir(), 'Mum - Cached.mp3'), makeMp3({ title: 'Cached', artist: 'Mum' }));
  writeFileSync(join(songsDir(), 'Mum - Slow.mp3'), Buffer.concat([makeMp3({ title: 'Slow', artist: 'Mum' }), Buffer.alloc(600_000)]));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await ftp.close(); });

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const songNamed = async file => (await api('/songs')).body.songs.find(s => s.file === file);
async function finished(jobId) {
  for (let i = 0; i < 400; i++) {
    const { body } = await api(`/save/${jobId}`);
    if (body.state !== 'running') return body;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('the save did not finish');
}
const songReads = () => ftp.reads.filter(name => /\.mp3$/i.test(name)).length;

test('a cloud song lands in the music folder and the library, with the list\'s title, artist and genre', async () => {
  const song = await songNamed('Mum - Song.mp3');
  await api(`/songs/${song.id}`, { method: 'PATCH', body: { genre: 'Pop' } });
  const started = await api('/save', { method: 'POST', body: { ids: [song.id] } });
  assert.equal(started.status, 202);
  const job = await finished(started.body.jobId);
  assert.equal(job.state, 'done');
  assert.deepEqual(job.saved.map(s => s.file), ['Mum - Song.mp3']);
  const path = join(music, 'Mum - Song.mp3');
  const { common } = await parseFile(path);
  assert.equal(common.title, 'Song', 'the list\'s title, not the file\'s old tag');
  assert.equal(common.artist, 'Mum');
  assert.deepEqual(common.genre, ['Pop']);
  assert.ok(listTracks().some(t => t.title === 'Song' && t.genre === 'Pop'), 'in the library');
  assert.equal((await songNamed('Mum - Song.mp3')).inLibrary, true);
});

test('saving it again: skipped, already in the library', async () => {
  const song = await songNamed('Mum - Song.mp3');
  const job = await finished((await api('/save', { method: 'POST', body: { ids: [song.id] } })).body.jobId);
  assert.equal(job.skipped.length, 1);
  assert.match(job.skipped[0].reason, /Already in your library/);
});

test('a song already cached on this laptop is copied, not downloaded again', async () => {
  const song = await songNamed('Mum - Cached.mp3');
  await fetchSong(song);
  const reads = songReads();
  const job = await finished((await api('/save', { method: 'POST', body: { ids: [song.id] } })).body.jobId);
  assert.equal(job.saved.length, 1);
  assert.equal(songReads(), reads, 'no download');
  assert.ok(existsSync(join(music, 'Mum - Cached.mp3')));
});

test('Stop leaves no half file', async () => {
  const song = await songNamed('Mum - Slow.mp3');
  const started = await api('/save', { method: 'POST', body: { ids: [song.id] } });
  await new Promise(r => setTimeout(r, 150));
  await api(`/save/${started.body.jobId}/cancel`, { method: 'POST' });
  const job = await finished(started.body.jobId);
  assert.equal(job.state, 'stopped');
  assert.deepEqual(readdirSync(music).filter(f => /\.part\./.test(f)), []);
  assert.equal(readdirSync(music).includes('Mum - Slow.mp3'), false);
});

test('an unknown id is ignored, an empty request refused', async () => {
  assert.equal((await api('/save', { method: 'POST', body: { ids: [] } })).status, 400);
  const job = await finished((await api('/save', { method: 'POST', body: { ids: [9999] } })).body.jobId);
  assert.equal(job.total, 0);
  assert.equal(readFileSync(join(music, 'Mum - Song.mp3')).length > 0, true);
});
