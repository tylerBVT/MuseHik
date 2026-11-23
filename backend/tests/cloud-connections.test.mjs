import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

// Throw-away settings, database and music folder: the real ones are never touched.
const tmp = mkdtempSync(join(tmpdir(), 'musehik-lanes-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
const { closeLanes, openLanes, setTimings } = await import('../modules/cloud/connections.mjs');
const { withCloud } = await import('../modules/cloud/store.mjs');
const { getUpload, startUpload } = await import('../modules/cloud/upload.mjs');

let ftp;
before(async () => { ftp = await startFtp(); });
afterEach(async () => { setTimings(); await closeLanes(); });
after(() => ftp.close());

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('two calls share one connection', async () => {
  const before = ftp.logins;
  await withCloud(c => c.index(), ftp.settings);
  await withCloud(c => c.session.list('songs'), ftp.settings);
  assert.equal(ftp.logins - before, 1);
  assert.deepEqual(openLanes(), ['listen']);
});

test('an upload uses its own lane, listening stays free', async () => {
  const src = join(tmp, 'Lane - Song.mp3');
  writeFileSync(src, Buffer.alloc(2000, 7));
  await withCloud(c => c.index(), ftp.settings);
  const job = startUpload({ paths: [src] }, ftp.settings);
  await waitFor(() => getUpload(job.id).state !== 'running', 'the upload');
  assert.equal(getUpload(job.id).uploaded.length, 1);
  assert.deepEqual(openLanes().sort(), ['listen', 'transfer']);
});

test('an idle lane closes by itself', async () => {
  setTimings({ idle: { listen: 50, transfer: 50 } });
  await withCloud(c => c.index(), ftp.settings);
  assert.deepEqual(openLanes(), ['listen']);
  await waitFor(() => openLanes().length === 0, 'the lane to close');
});

test('a connection dropped by the server is reopened on the next call', async () => {
  await withCloud(c => c.index(), ftp.settings);
  const before = ftp.logins;
  ftp.dropConnections();
  await new Promise(r => setTimeout(r, 100));
  const index = await withCloud(c => c.index(), ftp.settings);
  assert.ok(Array.isArray(index.songs));
  assert.equal(ftp.logins - before, 1, 'one new login');
});

test('a lane silent for too long is checked before use', async () => {
  setTimings({ stale: 0 }); // every use counts as "after a long silence"
  await withCloud(c => c.index(), ftp.settings);
  const index = await withCloud(c => c.index(), ftp.settings);
  assert.ok(Array.isArray(index.songs));
});

test('the traffic counter is gone: no usage.json is written', async () => {
  await withCloud(c => c.index(), ftp.settings);
  await closeLanes();
  assert.equal(existsSync(join(ftp.root, 'music', 'usage.json')), false);
});

test('new settings close the old lanes', async () => {
  await withCloud(c => c.index(), ftp.settings);
  const before = ftp.logins;
  await withCloud(c => c.index(), { ...ftp.settings, cacheLimitGB: 3 }); // not a connection detail: same lane
  assert.equal(ftp.logins - before, 0);
  await withCloud(c => c.index(), { ...ftp.settings, folder: 'music2' });
  assert.equal(ftp.logins - before, 1, 'another folder: a new connection');
});
