import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

// Throw-away database, music folder, settings and cache: the real ones are never touched.
const tmp = mkdtempSync(join(tmpdir(), 'musehik-cache-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { addFile } = await import('../core/library.mjs');
const { cachedIds, evict, fetchSong, localSource, touch } = await import('../modules/cloud/cache.mjs');

let ftp;
before(async () => {
  ftp = await startFtp();
  mkdirSync(join(ftp.root, 'music', 'songs'), { recursive: true });
});
after(() => ftp.close());

/** Puts a song on the fake cloud and returns its index entry. */
function cloudSong(id, title, size) {
  const file = `X - ${title}.mp3`;
  writeFileSync(join(ftp.root, 'music', 'songs', file), Buffer.alloc(size, id));
  return { id, file, title, artist: 'X', album: '', duration: 0, isrc: null, size };
}
/** How many times the server sent song files (JSON files not counted). */
const songDownloads = () => ftp.reads.filter(name => /.mp3$/i.test(name)).length;

test('prefers the local library copy', async () => {
  const path = join(tmp, 'music', 'Local Artist - Local Song.mp3');
  writeFileSync(path, Buffer.alloc(100));
  await addFile(path);
  const song = { id: 99, file: 'whatever.mp3', title: 'Local Artist - Local Song', artist: '', duration: 0, size: 100 };
  assert.deepEqual(localSource(song), { path, from: 'library' });
});

test('fetching a song that is in the local library downloads nothing', async () => {
  const song = { id: 98, file: 'X - Local Copy.mp3', title: 'Local Artist - Local Song', artist: '', duration: 0, size: 100 };
  const logins = ftp.logins;
  assert.equal(await fetchSong(song, ftp.settings), join(tmp, 'music', 'Local Artist - Local Song.mp3'));
  assert.equal(ftp.logins, logins, 'no connection');
  assert.equal(cachedIds().has(98), false);
});

test('fetches once and serves from cache after', async () => {
  const song = cloudSong(1, 'One', 5000);
  assert.equal(localSource(song), null);
  const path = await fetchSong(song, ftp.settings);
  assert.deepEqual(readFileSync(path), Buffer.alloc(5000, 1));
  assert.deepEqual(localSource(song), { path, from: 'cache' });
  assert.ok(cachedIds().has(1));
  rmSync(join(ftp.root, 'music', 'songs', song.file)); // gone from the cloud: the cached copy still serves
  assert.equal(await fetchSong(song, ftp.settings), path);
});

test('two concurrent fetches download once', async () => {
  const song = cloudSong(2, 'Two', 200000);
  const before = songDownloads();
  const [a, b] = await Promise.all([fetchSong(song, ftp.settings), fetchSong(song, ftp.settings)]);
  assert.equal(a, b);
  assert.equal(songDownloads() - before, 1);
  assert.equal(existsSync(`${a}.part`), false);
});

test('evicts least recently used, keeps the newest', async () => {
  const s3 = cloudSong(3, 'Three', 100);
  const s4 = cloudSong(4, 'Four', 100);
  const s5 = cloudSong(5, 'Five', 100);
  evict(0, -1); // start from an empty cache
  assert.equal(cachedIds().size, 0);
  for (const s of [s3, s4, s5]) await fetchSong(s, ftp.settings);
  touch(s3); // s3 played again: s4 is now the oldest of the three
  evict(200, 5); // room for two of the three
  const ids = cachedIds();
  assert.equal(ids.has(4), false, 'least recently used removed');
  assert.ok(ids.has(3) && ids.has(5));
  evict(0, 5);
  assert.deepEqual([...cachedIds()], [5], 'the song being played is never removed');
  assert.ok(existsSync(localSource(s5).path));
});
