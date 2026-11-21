import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-routes-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { monthKey } = await import('../modules/cloud/limits.mjs');

let ftp, base;
before(async () => {
  ftp = await startFtp();
  const { host, port, user, password, allowPlainFtp } = ftp.settings;
  saveSettings({ host, port, user, password, allowPlainFtp });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await ftp.close(); });

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
async function waitUpload(jobId) {
  for (let i = 0; i < 400; i++) {
    const { body } = await api(`/upload/${jobId}`);
    if (body.state !== 'running') return body;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('upload did not finish');
}

test('settings GET never returns the password', async () => {
  const { status, body } = await api('/settings');
  assert.equal(status, 200);
  assert.equal(body.hasPassword, true);
  assert.equal('password' in body, false);
  assert.equal(JSON.stringify(body).includes(ftp.settings.password), false);
  const saved = await api('/settings', { method: 'PUT', body: { monthlyLimitGB: 10 } });
  assert.equal(saved.status, 200);
  assert.equal('password' in saved.body, false);
});

test('connection test and status', async () => {
  assert.deepEqual((await api('/test', { method: 'POST' })).body, { ok: true, secure: false });
  const { body } = await api('/status');
  assert.equal(body.configured, true);
  assert.equal(body.limitBytes, 10e9);
  assert.equal(body.storageLimitBytes, 30e9);
});

test('upload then list then stream with Range 206', async () => {
  const src = join(tmp, 'Route Artist - Route Song.mp3');
  const bytes = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));
  writeFileSync(src, bytes);
  const started = await api('/upload', { method: 'POST', body: { paths: [src] } });
  assert.equal(started.status, 202);
  const job = await waitUpload(started.body.jobId);
  assert.equal(job.uploaded.length, 1);

  const list = await api('/songs');
  const song = list.body.songs.find(s => s.title === 'Route Artist - Route Song');
  assert.ok(song);
  assert.equal(song.onLaptop, false);
  assert.equal(list.body.offline, false);

  const response = await fetch(`${base}/songs/${song.id}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 100));
  const again = await api('/songs');
  assert.equal(again.body.songs.find(s => s.id === song.id).onLaptop, true, 'cached after the first play');
});

test('stream refuses with 429 at the limit', async () => {
  mkdirSync(join(ftp.root, 'music', 'songs'), { recursive: true });
  writeFileSync(join(ftp.root, 'music', 'songs', 'Far - Away.mp3'), Buffer.alloc(1000));
  await api('/rebuild', { method: 'POST' });
  const song = (await api('/songs')).body.songs.find(s => s.file === 'Far - Away.mp3');
  writeFileSync(join(ftp.root, 'music', 'usage.json'), JSON.stringify({ months: { [monthKey()]: { bytes: 11e9 } } }));
  const { status, body } = await api(`/songs/${song.id}/stream`);
  assert.equal(status, 429);
  assert.match(body.error, /^Cloud limit reached for /);
  const statusNow = (await api('/status')).body;
  assert.equal(statusNow.reached, true);
  writeFileSync(join(ftp.root, 'music', 'usage.json'), JSON.stringify({ months: {} }));
});

test('delete removes the song', async () => {
  const song = (await api('/songs')).body.songs.find(s => s.file === 'Far - Away.mp3');
  assert.equal((await api(`/songs/${song.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/songs')).body.songs.some(s => s.id === song.id), false);
  assert.equal((await api(`/songs/${song.id}`, { method: 'DELETE' })).status, 404);
});
