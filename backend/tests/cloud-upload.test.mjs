import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-upload-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
const { activeUpload, cancelUpload, getUpload, queueUpload, scanFolder, startUpload } = await import('../modules/cloud/upload.mjs');

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

test('stops at the storage limit', async () => {
  const paths = makeSongs(join(tmp, 'set2'), ['Limit - A', 'Limit - B', 'Limit - C']);
  const stored = cloudIndex().songs.reduce((sum, s) => sum + s.size, 0);
  const job = await finished(startUpload({ paths }, { ...ftp.settings, storageLimitGB: (stored + 150_000) / 1e9 }));
  assert.equal(job.state, 'done');
  assert.equal(job.uploaded.length, 1);
  assert.equal(job.failed.length, 2);
  for (const item of job.failed) assert.match(item.reason, /^Not enough cloud storage/);
});

test('cancel leaves no partial file', async () => {
  const [path] = makeSongs(join(tmp, 'set3'), ['Big - Song'], 150_000_000);
  const before = cloudIndex().songs.length;
  const job = startUpload({ paths: [path] }, ftp.settings);
  while (getUpload(job.id).bytesDone === 0 && getUpload(job.id).state === 'running') await new Promise(r => setImmediate(r));
  cancelUpload(job.id);
  const end = await finished(job);
  assert.equal(end.state, 'stopped');
  assert.equal(cloudSongs().some(f => f.includes('.part')), false, `no half file: ${cloudSongs().join(', ')}`);
  // Stop can land just after the last byte: then the song is complete and kept. Files and index must agree.
  const onCloud = cloudSongs().includes('Big - Song.mp3');
  assert.equal(end.uploaded.length === 1, onCloud);
  assert.equal(cloudIndex().songs.length, before + (onCloud ? 1 : 0));
});

test('a second upload cannot start while one is running', async () => {
  const [path] = makeSongs(join(tmp, 'set4'), ['Busy - Song'], 30_000_000);
  const job = startUpload({ paths: [path] }, ftp.settings);
  assert.throws(() => startUpload({ paths: [path] }, ftp.settings), /already running/);
  cancelUpload(job.id);
  await finished(job);
});

test('an upload asked while another runs waits, then goes right after it', async () => {
  const [first] = makeSongs(join(tmp, 'set5'), ['Queue - First'], 20_000_000);
  const [second] = makeSongs(join(tmp, 'set6'), ['Queue - Second']);
  const started = queueUpload({ paths: [first] }, ftp.settings);
  assert.ok(started.jobId);
  assert.deepEqual(queueUpload({ paths: [second] }, ftp.settings), { queued: true });
  await finished(getUpload(started.jobId));
  for (let i = 0; i < 400 && !cloudSongs().includes('Queue - Second.mp3'); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(cloudSongs().includes('Queue - First.mp3'));
  assert.ok(cloudSongs().includes('Queue - Second.mp3'), 'the waiting upload ran');
  const next = activeUpload();
  if (next) await finished(next);
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

test('removeAfter: a file safely on the cloud leaves the laptop, a failed one stays', async () => {
  const { addFile, hasPath } = await import('../core/library.mjs');
  const music = join(tmp, 'music');
  const [sent, refused, twin] = makeSongs(music, ['Gone - Sent', 'Kept - Refused', 'Artist - One']);
  for (const path of [sent, refused, twin]) await addFile(path);
  const stored = cloudIndex().songs.reduce((sum, s) => sum + s.size, 0);
  const settings = { ...ftp.settings, storageLimitGB: (stored + 150_000) / 1e9 }; // room for one song only
  const job = await finished(startUpload({ paths: [sent, refused, twin], removeAfter: [sent, refused, twin] }, settings));
  assert.equal(job.uploaded.length, 1);
  assert.equal(existsSync(sent), false, 'uploaded: deleted from the laptop');
  assert.equal(hasPath(sent), false, 'and from the library');
  assert.equal(existsSync(refused), true, 'not uploaded: kept');
  assert.equal(hasPath(refused), true);
  assert.match(job.failed[0].reason, /kept on this laptop/);
  assert.equal(job.removed, 1);
});

test('removeAfter: a song the cloud already has leaves the laptop too', async () => {
  const { addFile, hasPath } = await import('../core/library.mjs');
  const [twin] = makeSongs(join(tmp, 'music'), ['Artist - Two']);
  await addFile(twin);
  const job = await finished(startUpload({ paths: [twin], removeAfter: [twin] }, ftp.settings));
  assert.equal(job.skipped.length, 1);
  assert.equal(existsSync(twin), false);
  assert.equal(hasPath(twin), false);
  assert.equal(job.removed, 1);
});

test('without removeAfter nothing is deleted', async () => {
  const [kept] = makeSongs(join(tmp, 'set7'), ['Stay - Here']);
  await finished(startUpload({ paths: [kept] }, ftp.settings));
  assert.equal(existsSync(kept), true);
});
