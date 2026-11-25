import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-routes-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');

let remote, base;
before(async () => {
  remote = await startCloud();
  
  saveSettings({ ...remote.settings });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await remote.close(); });

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

test('settings GET never returns the key', async () => {
  const { status, body } = await api('/settings');
  assert.equal(status, 200);
  assert.equal(body.hasKey, true);
  assert.equal(body.url, remote.settings.url);
  assert.ok(body.displayName, 'the name shown on shared playlists');
  assert.equal('key' in body, false);
  assert.equal(JSON.stringify(body).includes(remote.settings.key), false);
  const saved = await api('/settings', { method: 'PUT', body: { cacheLimitGB: 2 } });
  assert.equal(saved.status, 200);
  assert.equal('key' in saved.body, false);
  const bad = await api('/settings', { method: 'PUT', body: { url: 'ftp://nope' } });
  assert.equal(bad.status, 400);
});

test('connection test and status', async () => {
  assert.deepEqual((await api('/test', { method: 'POST' })).body, { ok: true, secure: false });
  const { body } = await api('/status');
  assert.equal(body.configured, true);
  assert.equal('limitBytes' in body, false);
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
  assert.equal(song.inLibrary, false);
  assert.equal(list.body.offline, false);

  const response = await fetch(`${base}/songs/${song.id}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 100));
  const again = await api('/songs');
  assert.equal(again.body.songs.find(s => s.id === song.id).onLaptop, true, 'cached after the first play');
});

test('a song added by hand streams in full', async () => {
  mkdirSync(join(remote.root, 'music', 'songs'), { recursive: true });
  writeFileSync(join(remote.root, 'music', 'songs', 'Far - Away.mp3'), Buffer.alloc(1000));
  await api('/rebuild', { method: 'POST' });
  const song = (await api('/songs')).body.songs.find(s => s.file === 'Far - Away.mp3');
  const response = await fetch(`${base}/songs/${song.id}/stream`);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 1000);
  assert.equal('usedBytes' in (await api('/status')).body, false, 'traffic is not counted');
});

test('delete removes the song', async () => {
  const song = (await api('/songs')).body.songs.find(s => s.file === 'Far - Away.mp3');
  assert.equal((await api(`/songs/${song.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/songs')).body.songs.some(s => s.id === song.id), false);
  assert.equal((await api(`/songs/${song.id}`, { method: 'DELETE' })).status, 404);
});

test('upload with queue: true waits behind a running upload instead of refusing', async () => {
  const big = join(tmp, 'Queue - Big.mp3');
  const small = join(tmp, 'Queue - Small.mp3');
  writeFileSync(big, Buffer.alloc(30_000_000, 1));
  writeFileSync(small, Buffer.alloc(1000, 2));
  const first = await api('/upload', { method: 'POST', body: { paths: [big] } });
  const second = await api('/upload', { method: 'POST', body: { paths: [small], queue: true } });
  assert.equal(second.status, 202);
  assert.ok(second.body.queued || second.body.jobId, JSON.stringify(second.body));
  await waitUpload(first.body.jobId);
  for (let i = 0; i < 200; i++) {
    if ((await api('/songs')).body.songs.some(s => s.file === 'Queue - Small.mp3')) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail('the queued song never reached the cloud');
});
