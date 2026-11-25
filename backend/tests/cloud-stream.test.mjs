// A cloud song starts playing before it is fully downloaded (the test server sends "Slow" songs over ~1 s).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-stream-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { localSource } = await import('../modules/cloud/cache.mjs');

const SIZE = 400_000;
const bytes = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7) % 256));

let remote, base;
before(async () => {
  remote = await startCloud({ slow: { pattern: /Slow/, chunk: 20_000, delayMs: 50 } }); // 20 pieces: about 1 s
  
  saveSettings({ ...remote.settings });
  mkdirSync(join(remote.root, 'music', 'songs'), { recursive: true });
  writeFileSync(join(remote.root, 'music', 'songs', 'Slow - One.mp3'), bytes);
  writeFileSync(join(remote.root, 'music', 'songs', 'Slow - Two.mp3'), bytes);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cloud`;
});
after(async () => { server.close(); await remote.close(); });

const songNamed = async file => (await (await fetch(`${base}/songs`)).json()).songs.find(s => s.file === file);

test('the first bytes arrive long before the download ends, and the song is byte-exact', async () => {
  const song = await songNamed('Slow - One.mp3');
  const start = Date.now();
  const response = await fetch(`${base}/songs/${song.id}/stream`, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-${SIZE - 1}/${SIZE}`);
  const reader = response.body.getReader();
  const chunks = [];
  const first = await reader.read();
  const firstByteMs = Date.now() - start;
  chunks.push(Buffer.from(first.value));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  const totalMs = Date.now() - start;
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.ok(totalMs > 600, `the test server is slow (${totalMs} ms)`);
  assert.ok(firstByteMs < totalMs * 0.4, `first byte after ${firstByteMs} ms of ${totalMs} ms`);
  // The last byte can be sent a moment before the file is recorded as cached.
  for (let i = 0; i < 40 && !localSource(song); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(localSource(song)?.from, 'cache', 'kept as the cached copy');
});

test('skipping the song mid-download still finishes the cached copy', async () => {
  const song = await songNamed('Slow - Two.mp3');
  const controller = new AbortController();
  const response = await fetch(`${base}/songs/${song.id}/stream`, { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  for (let i = 0; i < 100 && !localSource(song); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(localSource(song)?.from, 'cache');
  const again = await fetch(`${base}/songs/${song.id}/stream`, { headers: { Range: 'bytes=1000-1999' } });
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes.subarray(1000, 2000));
});
