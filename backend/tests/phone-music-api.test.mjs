// The phone's client for the music API (frontend/src/app/features/cloud/music-api.ts, plain TypeScript that Node
// runs by stripping the types) against the real PHP API.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMp3 } from './mp3-fixture.mjs';
import { findPhp, startApi } from './php-fixture.mjs';

const skip = findPhp() ? false : 'PHP not found';
const { createMusicApi, cleanUrl } = await import('../../frontend/src/app/features/cloud/music-api.ts');

describe('the phone\'s music API client', { skip }, () => {
  let api, server, cloudDir;
  before(async () => {
    cloudDir = mkdtempSync(join(tmpdir(), 'phone-api-'));
    mkdirSync(join(cloudDir, 'songs'));
    server = await startApi({ dataDir: cloudDir, key: 'phone-key-123' });
    api = createMusicApi({ url: server.base, key: 'phone-key-123' });
  });
  after(async () => { await server?.close(); });

  test('cleanUrl adds https:// and drops trailing slashes; nonsense is refused', () => {
    assert.equal(cleanUrl('www.example.com/music-api/'), 'https://www.example.com/music-api');
    assert.equal(cleanUrl(' http://192.168.1.20:8000 '), 'http://192.168.1.20:8000');
    assert.throws(() => cleanUrl('not a url at all'), /must look like https:\/\//);
    assert.equal(cleanUrl(''), '');
  });

  test('upload sends the song with its details and reports progress', async () => {
    const seen = [];
    const mp3 = makeMp3({ seconds: 2 });
    const song = await api.upload(new Blob([mp3]), 'whatever.mp3',
      { title: 'One', artist: 'Band', album: 'First', duration: 2, isrc: 'FR1', addedBy: 'Phone' },
      { onProgress: (sent, total) => seen.push([sent, total]) });
    assert.equal(song.file, 'Band - One.mp3');
    assert.equal(song.album, 'First');
    assert.equal(song.addedBy, 'Phone');
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1)[0], seen.at(-1)[1]);
  });

  test('a twin is refused as a 409 that carries the song already there', async () => {
    const error = await api.upload(new Blob([makeMp3({ seconds: 2 })]), 'x.mp3', { title: 'One', artist: 'Band', duration: 2 })
      .catch(e => e);
    assert.equal(error.status, 409);
    assert.equal(error.song.title, 'One');
    assert.equal(error.message, 'This song is already on the cloud.');
  });

  test('songs, status, the file URL, edit and delete', async () => {
    const { songs } = await api.songs();
    assert.deepEqual(songs.map(s => s.title), ['One']);
    const status = await api.status();
    assert.equal(status.songs, 1);
    assert.equal(status.storedBytes, songs[0].size);

    const res = await fetch(api.fileUrl(songs[0].id));
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(cloudDir, 'songs', 'Band - One.mp3')));

    const renamed = await api.editSong(songs[0].id, { title: 'Uno', genre: 'Rock' });
    assert.equal(renamed.file, 'Band - Uno.mp3');
    assert.equal(renamed.genre, 'Rock');
    await assert.rejects(api.editSong(songs[0].id, { title: ' ' }), e => e.status === 400 && e.message === 'A song needs a title.');

    assert.equal(await api.deleteSong(songs[0].id), true);
    assert.equal(await api.deleteSong(songs[0].id), false);
  });

  test('playlists: create, list with playable ids, update, delete', async () => {
    const song = await api.upload(new Blob([makeMp3({ seconds: 1 })]), 'Artist - Two.mp3', { duration: 1 });
    const made = await api.createPlaylist({ name: 'Road', owner: 'Phone', songs: [{ id: song.id }, { title: 'Elsewhere', artist: 'X' }] });
    assert.equal(made.name, 'Road');
    let [listed] = await api.playlists();
    assert.equal(listed.id, made.id);
    assert.deepEqual(listed.songs.map(s => s.songId), [song.id, null]);
    await api.updatePlaylist(made.id, { name: 'Trip', songs: [{ id: song.id }] });
    [listed] = await api.playlists();
    assert.equal(listed.name, 'Trip');
    assert.equal(listed.songs.length, 1);
    await api.deletePlaylist(made.id);
    assert.deepEqual(await api.playlists(), []);
  });

  test('a stopped upload rejects as "stopped"', async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(api.upload(new Blob([makeMp3({ seconds: 1 })]), 'Stop - Me.mp3', {}, { signal: stop.signal }), /stopped/);
  });

  test('wrong key, not the API, nothing there: plain sentences', async () => {
    await assert.rejects(createMusicApi({ url: server.base, key: 'wrong-key-999' }).status(),
      e => e.status === 401 && e.message === 'Wrong key. Check the cloud key in Settings.');

    const site = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Hi</html>'); });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(createMusicApi({ url: `http://127.0.0.1:${site.address().port}`, key: 'k' }).status(),
        /does not answer like the music API/);
    } finally { site.close(); }

    const gone = http.createServer();
    await new Promise(resolve => gone.listen(0, '127.0.0.1', resolve));
    const port = gone.address().port;
    await new Promise(resolve => gone.close(resolve));
    await assert.rejects(createMusicApi({ url: `http://127.0.0.1:${port}`, key: 'k' }).status(),
      new RegExp(`^Error: Cannot reach 127\\.0\\.0\\.1:${port}\\. Check the address and your internet connection\\.`));
  });
});
