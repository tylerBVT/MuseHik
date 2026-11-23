import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

process.env.CLOUD_SETTINGS = join(mkdtempSync(join(tmpdir(), 'cloud-store-')), 'cloud.json');
const { monthKey } = await import('../modules/cloud/limits.mjs');
const { lastIndex, rebuildIndex, withCloud } = await import('../modules/cloud/store.mjs');

let ftp;
before(async () => { ftp = await startFtp(); });
after(() => ftp.close());

const cloudFile = name => join(ftp.root, 'music', name);
const readCloud = name => JSON.parse(readFileSync(cloudFile(name), 'utf8'));
const song = (title, size = 100) => ({ file: `X - ${title}.mp3`, title, artist: 'X', album: '', duration: 180, isrc: null, size });

test('addSong assigns increasing ids and keeps the other laptop\'s songs', async () => {
  await withCloud(async cloud => {
    const a = await cloud.addSong(song('A'));
    // Meanwhile, the other laptop adds a song straight into library.json.
    const index = readCloud('library.json');
    index.songs.push({ ...song('Other'), id: index.nextId, addedBy: 'mum-laptop' });
    index.nextId += 1;
    writeFileSync(cloudFile('library.json'), JSON.stringify(index));
    const b = await cloud.addSong(song('B'));
    assert.ok(b.id > a.id);
    assert.equal(b.key, 'x|b');
    assert.ok(b.addedBy && b.addedAt);
  }, ftp.settings);
  const titles = readCloud('library.json').songs.map(s => s.title);
  assert.deepEqual(titles, ['A', 'Other', 'B']);
  assert.deepEqual(lastIndex().songs.map(s => s.title), ['A', 'Other', 'B'], 'a local copy is kept for offline use');
});

test('removeSong deletes the file and the entry', async () => {
  mkdirSync(cloudFile('songs'), { recursive: true });
  let id;
  await withCloud(async cloud => {
    writeFileSync(cloudFile('songs/X - Gone.mp3'), 'x');
    id = (await cloud.addSong(song('Gone', 1))).id;
    assert.equal(await cloud.removeSong(id), true);
    assert.equal(await cloud.removeSong(id), false);
  }, ftp.settings);
  assert.equal(readCloud('library.json').songs.some(s => s.id === id), false);
  assert.deepEqual((await withCloud(c => c.session.list('songs'), ftp.settings)).map(f => f.name).includes('X - Gone.mp3'), false);
});

test('usage is added at the end of a session even after an error', async () => {
  const before = readCloudUsage();
  await assert.rejects(withCloud(async cloud => {
    await cloud.index();
    throw new Error('boom');
  }, ftp.settings), /boom/);
  assert.ok(readCloudUsage() > before, `${readCloudUsage()} > ${before}`);
});

function readCloudUsage() {
  try { return readCloud('usage.json').months[monthKey()].bytes; } catch { return 0; }
}

test('ensureRoom never refuses because of traffic (her hosting has no traffic limit)', async () => {
  const month = monthKey();
  writeFileSync(cloudFile('usage.json'), JSON.stringify({ months: { [month]: { bytes: 500e9 } } }));
  await withCloud(async cloud => {
    await cloud.ensureRoom(2e9);
  }, ftp.settings);
  writeFileSync(cloudFile('usage.json'), JSON.stringify({ months: {} }));
});

test('ensureRoom with storage checks the 30 GB cap', async () => {
  await withCloud(async cloud => {
    await cloud.addSong(song('Huge', 29.99e9));
    await cloud.ensureRoom(1e6); // traffic only: fine
    await assert.rejects(async () => cloud.ensureRoom(2e7, { storage: true }), /Not enough cloud storage/);
    const huge = (await cloud.index()).songs.find(s => s.title === 'Huge');
    await cloud.removeSong(huge.id);
  }, ftp.settings);
});

test('rebuildIndex re-adds orphan files and drops entries without a file', async () => {
  mkdirSync(cloudFile('songs'), { recursive: true });
  writeFileSync(cloudFile('songs/Orelsan - Basique.mp3'), Buffer.alloc(1234));
  const result = await rebuildIndex(ftp.settings);
  const songs = readCloud('library.json').songs;
  const orphan = songs.find(s => s.file === 'Orelsan - Basique.mp3');
  assert.ok(orphan, 'orphan file re-added');
  assert.equal(orphan.artist, 'Orelsan');
  assert.equal(orphan.title, 'Basique');
  assert.equal(orphan.size, 1234);
  assert.equal(songs.some(s => s.title === 'A'), false, 'entry without a file dropped');
  assert.equal(result.added, 1);
  assert.ok(result.removed >= 3);
});
