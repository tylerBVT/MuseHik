// streamGrowing: serving a file while it is still being downloaded (cloud songs start before they are complete).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamGrowing } from '../core/http.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-growing-'));
const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));

/** A download in progress, driven by the test: `grow(n)` lands n more bytes, `finish()` ends it, `fail()` breaks it. */
function fakeDownload(name, first) {
  const path = join(tmp, name);
  writeFileSync(path, bytes.subarray(0, first));
  let wake = () => {};
  const source = {
    path, target: path, size: bytes.length, written: first, done: false, error: null,
    changed: () => new Promise(resolve => { wake = resolve; setTimeout(resolve, 200); }),
    grow(n) {
      appendFileSync(path, bytes.subarray(source.written, source.written + n));
      source.written += n;
      wake();
    },
    finish() { source.grow(bytes.length - source.written); source.done = true; wake(); },
    fail() { source.error = new Error('lost'); wake(); },
  };
  return source;
}

let current;
const server = createServer((req, res) => { void streamGrowing(req, res, current, {}); });
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

async function readAll(reader, chunks = []) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(value));
  }
}

test('the first bytes are sent before the download ends', async () => {
  current = fakeDownload('a.mp3', 1000);
  const response = await fetch(base, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-2999/3000');
  assert.equal(response.headers.get('content-length'), '3000');
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.length > 0 && first.value.length <= 1000, 'only what is downloaded');
  assert.equal(current.done, false, 'still downloading');
  current.grow(1000);
  current.finish();
  const body = await readAll(reader, [Buffer.from(first.value)]);
  assert.deepEqual(body, bytes);
});

test('a range beyond what is downloaded waits for its bytes', async () => {
  current = fakeDownload('b.mp3', 500);
  const pending = fetch(base, { headers: { Range: 'bytes=2500-2999' } });
  setTimeout(() => current.grow(1000), 30);
  setTimeout(() => current.finish(), 60);
  const response = await pending;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2500-2999/3000');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2500, 3000));
});

test('no Range header: 200 with the full length', async () => {
  current = fakeDownload('c.mp3', 3000);
  current.done = true;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('a download that breaks cuts the response', async () => {
  current = fakeDownload('d.mp3', 1000);
  const response = await fetch(base);
  const reader = response.body.getReader();
  await reader.read();
  current.fail();
  await assert.rejects(readAll(reader));
});

test('a slow listener does not pile up close listeners (one per wait for the socket)', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  const path = join(tmp, 'big.mp3');
  writeFileSync(path, big);
  const source = { path, target: path, size: big.length, written: big.length, done: true, error: null, changed: async () => {} };
  let peak = 0;
  const watched = createServer((req, res) => {
    const timer = setInterval(() => { peak = Math.max(peak, res.listenerCount('close')); }, 1);
    void streamGrowing(req, res, source, {}).finally(() => clearInterval(timer));
  });
  await new Promise(resolve => watched.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${watched.address().port}/`, { headers: { Range: 'bytes=0-' } });
  const reader = response.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    await new Promise(r => setTimeout(r, 2)); // reads slowly, like the audio element's buffer
  }
  watched.close();
  assert.equal(total, big.length);
  assert.ok(peak <= 4, `at most a few close listeners at once (saw ${peak})`);
});
