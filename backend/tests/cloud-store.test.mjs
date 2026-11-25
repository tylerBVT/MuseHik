// The laptop's cloud client (store.mjs + api.mjs) against the real music API.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noPhp, startCloud } from './cloud-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cloud-store-'));
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
const { cloudStatus, lastIndex, rebuildIndex, withCloud, EditError } = await import('../modules/cloud/store.mjs');
const { testConnection } = await import('../modules/cloud/api.mjs');

const mp3 = (name, seconds = 1) => {
  const path = join(tmp, name);
  writeFileSync(path, makeMp3({ seconds }));
  return path;
};

describe('the cloud through the music API', { skip: noPhp }, () => {
  let cloud;
  const readCloud = name => JSON.parse(readFileSync(join(cloud.cloudDir, name), 'utf8'));
  before(async () => { cloud = await startCloud(); });
  after(async () => { await cloud?.close(); });

  test('upload stores the song with its details; the list comes back and a copy is kept for offline use', async () => {
    const song = await withCloud(c => c.upload(mp3('a.mp3'), {
      title: 'One', artist: 'Band', album: 'First', duration: 1, isrc: 'FR1234567890', addedBy: 'laptop-1',
    }), cloud.settings);
    assert.equal(song.file, 'Band - One.mp3');
    assert.equal(song.album, 'First');
    assert.equal(song.isrc, 'FR1234567890');
    assert.equal(song.addedBy, 'laptop-1');
    assert.ok(existsSync(join(cloud.cloudDir, 'songs', 'Band - One.mp3')));
    const { songs } = await withCloud(c => c.index(), cloud.settings);
    assert.deepEqual(songs.map(s => s.title), ['One']);
    assert.deepEqual(lastIndex().songs, songs);
  });

  test('a song the cloud already has is refused with the twin (409)', async () => {
    const error = await withCloud(c => c.upload(mp3('b.mp3'), { title: 'One', artist: 'Band', duration: 1 }), cloud.settings)
      .catch(e => e);
    assert.equal(error.status, 409);
    assert.equal(error.song.title, 'One');
    assert.match(error.message, /^Cloud: /);
  });

  test('progress is reported while uploading', async () => {
    const seen = [];
    await withCloud(c => c.upload(mp3('c.mp3', 3), { title: 'Two', artist: 'Band', duration: 3 }, { onBytes: n => seen.push(n) }), cloud.settings);
    assert.ok(seen.length > 0);
    assert.ok(seen.at(-1) > 0);
  });

  test('editSong renames on the cloud; bad changes are EditErrors; unknown ids give null', async () => {
    const { songs } = await withCloud(c => c.index(), cloud.settings);
    const two = songs.find(s => s.title === 'Two');
    const after = await withCloud(c => c.editSong(two.id, { title: 'Deux' }), cloud.settings);
    assert.equal(after.file, 'Band - Deux.mp3');
    assert.equal(lastIndex().songs.find(s => s.id === two.id).title, 'Deux', 'the local copy follows');
    await assert.rejects(withCloud(c => c.editSong(two.id, { title: ' ' }), cloud.settings), e => e instanceof EditError && /needs a title/.test(e.message));
    assert.equal(await withCloud(c => c.editSong(999, { title: 'X' }), cloud.settings), null);
  });

  test('updateSong fills in tags read on the laptop', async () => {
    const { songs } = await withCloud(c => c.index(), cloud.settings);
    const one = songs.find(s => s.title === 'One');
    const after = await withCloud(c => c.updateSong(one.id, { duration: 1.5, album: 'Other' }), cloud.settings);
    assert.equal(after.duration, 1.5);
    assert.equal(after.album, 'Other');
  });

  test('download copies the file; removeSong deletes it (and says false the second time)', async () => {
    const { songs } = await withCloud(c => c.index(), cloud.settings);
    const one = songs.find(s => s.title === 'One');
    const copy = join(tmp, 'copy.mp3');
    await withCloud(c => c.download(one, copy), cloud.settings);
    assert.deepEqual(readFileSync(copy), readFileSync(join(cloud.cloudDir, 'songs', one.file)));
    assert.equal(await withCloud(c => c.removeSong(one.id), cloud.settings), true);
    assert.equal(await withCloud(c => c.removeSong(one.id), cloud.settings), false);
    assert.equal(existsSync(join(cloud.cloudDir, 'songs', one.file)), false);
    assert.equal(lastIndex().songs.some(s => s.id === one.id), false);
  });

  test('rebuildIndex picks up files added by hand and drops entries without a file', async () => {
    mkdirSync(join(cloud.cloudDir, 'songs'), { recursive: true });
    writeFileSync(join(cloud.cloudDir, 'songs', 'Orelsan - Basique.mp3'), Buffer.alloc(1234));
    const index = readCloud('library.json');
    index.songs.push({ ...index.songs[0], id: 77, file: 'Lost - Song.mp3', title: 'Song' });
    writeFileSync(join(cloud.cloudDir, 'library.json'), JSON.stringify(index));
    assert.deepEqual(await rebuildIndex(cloud.settings), { added: 1, removed: 1 });
    const orphan = readCloud('library.json').songs.find(s => s.file === 'Orelsan - Basique.mp3');
    assert.equal(orphan.artist, 'Orelsan');
    assert.equal(orphan.size, 1234);
  });

  test('playlists: raw list with delete markers, and put keeps only newer changes', async () => {
    const entry = { uid: 'pl-1', name: 'Road', owner: 'Tyler', updatedAt: 1000, songs: [] };
    assert.equal((await withCloud(c => c.putPlaylist(entry), cloud.settings)).applied, true);
    assert.equal((await withCloud(c => c.putPlaylist({ ...entry, updatedAt: 999 }), cloud.settings)).applied, false);
    await withCloud(c => c.putPlaylist({ uid: 'pl-2', deleted: true, updatedAt: 5 }), cloud.settings);
    assert.deepEqual(await withCloud(c => c.playlists(), cloud.settings), [entry, { uid: 'pl-2', deleted: true, updatedAt: 5 }]);
  });

  test('cloudStatus: the storage bar from the server\'s numbers', async () => {
    const status = await cloudStatus(cloud.settings);
    const stored = readCloud('library.json').songs.reduce((sum, s) => sum + s.size, 0);
    assert.equal(status.configured, true);
    assert.equal(status.online, true);
    assert.equal(status.storedBytes, stored);
    assert.equal(status.storageLimitBytes, 30e9);
  });

  test('an error inside withCloud reaches the caller', async () => {
    await assert.rejects(withCloud(async c => { await c.index(); throw new Error('boom'); }, cloud.settings), /boom/);
  });

  test('a wrong key, a wrong address and an unreachable address read as plain sentences', async () => {
    await assert.rejects(withCloud(c => c.index(), { ...cloud.settings, key: 'wrong-key-123' }), /^Error: Cloud: wrong key/);
    assert.deepEqual(await testConnection({ ...cloud.settings, key: 'wrong-key-123' }), { ok: false, error: 'wrong key. Check the cloud key in Settings.' });
    assert.deepEqual(await testConnection(cloud.settings), { ok: true, secure: false });

    // A website that is not the API (the hosting's home page) answers 200 with HTML.
    const site = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Welcome</html>'); });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    try {
      const result = await testConnection({ ...cloud.settings, url: `http://127.0.0.1:${site.address().port}` });
      assert.equal(result.ok, false);
      assert.match(result.error, /does not answer like the music API/);
    } finally { site.close(); }

    // Nothing listens on a port that was just freed.
    const gone = http.createServer();
    await new Promise(resolve => gone.listen(0, '127.0.0.1', resolve));
    const port = gone.address().port;
    await new Promise(resolve => gone.close(resolve));
    const closed = await testConnection({ ...cloud.settings, url: `http://127.0.0.1:${port}` });
    assert.match(closed.error, new RegExp(`^cannot reach 127\\.0\\.0\\.1:${port}\\. Check the address`));
  });

  test('not set up, or offline: no request at all', async () => {
    const before = cloud.requests;
    await assert.rejects(withCloud(c => c.index(), { ...cloud.settings, key: '' }), /not set up/);
    await assert.rejects(withCloud(c => c.index(), { ...cloud.settings, online: false }), /offline/);
    assert.deepEqual(await cloudStatus({ ...cloud.settings, online: false }), { configured: true, online: false });
    assert.equal(cloud.requests, before);
  });
});

describe('a full cloud', { skip: noPhp }, () => {
  test('an upload past the storage cap is refused with the free space (413)', async () => {
    const small = await startCloud({ config: { storageLimitGB: 0.00002 } }); // 20 kB
    try {
      const error = await withCloud(c => c.upload(mp3('big.mp3', 3), { title: 'Big', artist: 'X', duration: 3 }), small.settings)
        .catch(e => e);
      assert.equal(error.status, 413);
      assert.match(error.message, /^Cloud: Not enough cloud storage/);
    } finally { await small.close(); }
  });
});
