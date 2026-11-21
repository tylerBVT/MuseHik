import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-upload-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
const { cancelUpload, getUpload, scanFolder, startUpload } = await import('../modules/cloud/upload.mjs');

let ftp;
before(async () => { ftp = await startFtp(); });
after(() => ftp.close());

const cloudSongs = () => { try { return readdirSync(join(ftp.root, 'music', 'songs')); } catch { return []; } };
const cloudIndex = () => JSON.parse(readFileSync(join(ftp.root, 'music', 'library.json'), 'utf8'));
async function finished(job) {
  for (let i = 0; i < 400 && getUpload(job.id).state === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  return getUpload(job.id);
}
function makeSongs(folder, names, size = 100000) {
  mkdirSync(folder, { recursive: true });
  return names.map((name, i) => {
    const path = join(folder, `${name}.mp3`);
    writeFileSync(path, Buffer.alloc(size, i + 1));
    return path;
  });
}

test('uploads, then skips the same songs on a second run', async () => {
  const paths = makeSongs(join(tmp, 'set1'), ['Artist - One', 'Artist - Two']);
  const first = await finished(startUpload({ paths }, ftp.settings));
  assert.equal(first.state, 'done');
  assert.deepEqual(first.uploaded.map(i => i.file).sort(), ['Artist - One.mp3', 'Artist - Two.mp3']);
  assert.equal(first.bytesDone, 200000);
  assert.deepEqual(cloudSongs().sort(), ['Artist - One.mp3', 'Artist - Two.mp3']);
  assert.equal(cloudIndex().songs.length, 2);

  const second = await finished(startUpload({ paths }, ftp.settings));
  assert.equal(second.uploaded.length, 0);
  assert.equal(second.skipped.length, 2);
  assert.match(second.skipped[0].reason, /^Already on the cloud as /);
  assert.equal(cloudIndex().songs.length, 2);
});

test('stops at the monthly limit', async () => {
  const paths = makeSongs(join(tmp, 'set2'), ['Limit - A', 'Limit - B', 'Limit - C']);
  writeFileSync(join(ftp.root, 'music', 'usage.json'), JSON.stringify({ months: {} }));
  const job = await finished(startUpload({ paths }, { ...ftp.settings, monthlyLimitGB: 0.00015 })); // 150 kB
  assert.equal(job.state, 'done');
  assert.equal(job.uploaded.length, 1);
  assert.equal(job.failed.length, 2);
  for (const item of job.failed) assert.match(item.reason, /^Cloud limit reached for /);
});

test('cancel leaves no partial file', async () => {
  const [path] = makeSongs(join(tmp, 'set3'), ['Big - Song'], 60_000_000);
  const before = cloudIndex().songs.length;
  const job = startUpload({ paths: [path] }, ftp.settings);
  for (let i = 0; i < 400 && getUpload(job.id).bytesDone === 0; i++) await new Promise(r => setTimeout(r, 5));
  cancelUpload(job.id);
  const end = await finished(job);
  assert.equal(end.state, 'stopped');
  assert.equal(cloudSongs().some(f => f.startsWith('Big - Song')), false, cloudSongs().join(', '));
  assert.equal(cloudIndex().songs.length, before);
});

test('a second upload cannot start while one is running', async () => {
  const [path] = makeSongs(join(tmp, 'set4'), ['Busy - Song'], 30_000_000);
  const job = startUpload({ paths: [path] }, ftp.settings);
  assert.throws(() => startUpload({ paths: [path] }, ftp.settings), /already running/);
  cancelUpload(job.id);
  await finished(job);
});

test('scanFolder lists audio files, in subfolders too, and nothing else', async () => {
  const folder = join(tmp, 'scan');
  makeSongs(folder, ['A - One']);
  makeSongs(join(folder, 'sub'), ['B - Two']);
  writeFileSync(join(folder, 'notes.txt'), 'x');
  writeFileSync(join(folder, 'cover.jpg'), 'x');
  writeFileSync(join(folder, 'half.part.mp3'), 'x');
  const songs = await scanFolder(folder);
  assert.deepEqual(songs.map(s => s.title).sort(), ['A - One', 'B - Two']);
  assert.equal(songs[0].size, 100000);
  await assert.rejects(scanFolder(join(tmp, 'missing')), /does not exist/);
});
