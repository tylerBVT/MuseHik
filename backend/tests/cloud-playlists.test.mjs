// Shared playlists: this laptop against a fake cloud. "Mum's laptop" is simulated by writing to playlists.json.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-shared-'));
const realConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
mkdirSync(join(tmp, 'music'));
readdirSync(realConfig.musicDir).filter(f => f.endsWith('.mp3')).slice(0, 2)
  .forEach((f, i) => copyFileSync(join(realConfig.musicDir, f), join(tmp, 'music', `s${i}.mp3`)));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');

const { listTracks, scanLibrary } = await import('../core/library.mjs');
const P = await import('../modules/musicPlayer/playlists.mjs');
const { saveSettings } = await import('../modules/cloud/settings.mjs');
const { syncPlaylists } = await import('../modules/cloud/playlistSync.mjs');
const { activeUpload } = await import('../modules/cloud/upload.mjs');
const { server } = await import('../server.mjs');

let ftp, base, a, b;
before(async () => {
  ftp = await startFtp();
  const { host, port, user, password, allowPlainFtp } = ftp.settings;
  saveSettings({ host, port, user, password, allowPlainFtp, name: 'Tyler' });
  await scanLibrary();
  [a, b] = listTracks();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server.close(); await ftp.close(); });

const cloudFile = name => join(ftp.root, 'music', name);
const cloudPlaylists = () => JSON.parse(readFileSync(cloudFile('playlists.json'), 'utf8')).playlists;
const writeCloudPlaylists = list => writeFileSync(cloudFile('playlists.json'), JSON.stringify({ version: 1, playlists: list }));
const byName = name => P.listPlaylists().find(p => p.name === name);
async function uploadsDone() {
  for (let i = 0; i < 400 && activeUpload(); i++) await new Promise(r => setTimeout(r, 25));
}

let roadTrip;
test('shared playlist is pushed with its songs', async () => {
  roadTrip = P.createPlaylist('Road trip', [a.id]);
  P.createPlaylist('Private', [b.id]);
  P.setShared(roadTrip.id, true, 'Tyler');
  const result = await syncPlaylists();
  assert.equal(result.pushed, 1);
  const pushed = cloudPlaylists().find(p => p.uid === roadTrip.uid);
  assert.equal(pushed.name, 'Road trip');
  assert.equal(pushed.owner, 'Tyler');
  assert.deepEqual(pushed.songs.map(s => s.title), [a.title]);
  assert.equal(cloudPlaylists().some(p => p.name === 'Private'), false, 'unshared playlists never leave the laptop');
  await uploadsDone();
});

test('sharing uploads songs missing from the cloud', async () => {
  const songs = existsSync(cloudFile('songs')) ? readdirSync(cloudFile('songs')) : [];
  assert.equal(songs.length, 1, `the shared playlist's song was uploaded: ${songs.join(', ')}`);
  const index = JSON.parse(readFileSync(cloudFile('library.json'), 'utf8'));
  assert.equal(index.songs[0].title, a.title);
  const again = await syncPlaylists({ force: true });
  assert.equal(again.uploading, 0, 'nothing left to upload');
});

test("another laptop's playlist appears here as shared from its owner", async () => {
  writeCloudPlaylists([...cloudPlaylists(), {
    uid: 'u-mum', name: "Mum's mix", owner: 'Mum', updatedAt: Date.now(),
    songs: [{ title: a.title, artist: a.artist, album: a.album, duration: a.duration, isrc: null }, { title: 'Far Song', artist: 'X', duration: 100 }],
  }]);
  const result = await syncPlaylists();
  assert.equal(result.pulled, 1);
  const mum = byName("Mum's mix");
  assert.ok(mum, 'pulled');
  assert.equal(mum.shared, true);
  assert.equal(mum.owner, 'Mum');
  const full = P.getPlaylist(mum.id);
  assert.equal(full.songs.length, 2);
  assert.equal(full.songs[0].trackId, a.id, 'a song this laptop has plays from the local file');
  assert.equal(full.songs[1].trackId, null);
});

test('newer side wins both ways', async () => {
  // The cloud is newer: Mum renamed her playlist.
  writeCloudPlaylists(cloudPlaylists().map(p => (p.uid === 'u-mum' ? { ...p, name: "Mum's mix 2", updatedAt: Date.now() + 1000 } : p)));
  await syncPlaylists();
  assert.ok(byName("Mum's mix 2"), 'renamed here');
  // This laptop is newer: I renamed mine.
  P.updatePlaylist(roadTrip.id, 'Road trip 2');
  await syncPlaylists();
  assert.equal(cloudPlaylists().find(p => p.uid === roadTrip.uid).name, 'Road trip 2');
  // An older cloud copy never overwrites a newer local edit (and is corrected).
  writeCloudPlaylists(cloudPlaylists().map(p => (p.uid === roadTrip.uid ? { ...p, name: 'stale', updatedAt: 1 } : p)));
  await syncPlaylists();
  assert.ok(byName('Road trip 2'));
  assert.equal(cloudPlaylists().find(p => p.uid === roadTrip.uid).name, 'Road trip 2');
});

test('unshare removes the cloud copy only', async () => {
  P.setShared(roadTrip.id, false);
  await syncPlaylists();
  const entry = cloudPlaylists().find(p => p.uid === roadTrip.uid);
  assert.equal(entry.deleted, true);
  assert.ok(byName('Road trip 2'), 'still here, just not shared');
  assert.equal(byName('Road trip 2').shared, false);
});

test('deleting a shared playlist removes it on the other side', async () => {
  // Deleted on the other laptop: gone here.
  writeCloudPlaylists(cloudPlaylists().map(p => (p.uid === 'u-mum' ? { uid: 'u-mum', deleted: true, updatedAt: Date.now() + 5000 } : p)));
  const result = await syncPlaylists();
  assert.equal(result.removed, 1);
  assert.equal(byName("Mum's mix 2"), undefined);
  // Deleted here: marked deleted on the cloud.
  const temp = P.createPlaylist('Short lived', [a.id]);
  P.setShared(temp.id, true, 'Tyler');
  await syncPlaylists();
  P.deletePlaylist(temp.id);
  await syncPlaylists();
  assert.equal(cloudPlaylists().find(p => p.uid === temp.uid).deleted, true);
  assert.deepEqual(P.tombstones().filter(t => t.uid === temp.uid), [], 'tombstone cleared once the cloud knows');
});

test('share route returns the playlist and syncs', async () => {
  const mine = P.createPlaylist('Via the API', [a.id]);
  const response = await fetch(`${base}/cloud/playlists/${mine.id}/share`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.shared, true);
  assert.equal(body.owner, 'Tyler');
  assert.equal(cloudPlaylists().find(p => p.uid === mine.uid).name, 'Via the API');
  const sync = await (await fetch(`${base}/cloud/playlists/sync`, { method: 'POST' })).json();
  assert.equal(sync.skipped, true, 'a sync right after another is skipped unless forced');
  await uploadsDone();
});

test('the other laptop unsharing or deleting my playlist keeps it here, unshared', async () => {
  const mine = P.createPlaylist('Mine, kept', [a.id]);
  P.setShared(mine.id, true, 'Tyler');
  await syncPlaylists({ force: true });
  writeCloudPlaylists(cloudPlaylists().map(p => (p.uid === mine.uid ? { uid: mine.uid, deleted: true, updatedAt: Date.now() + 10000 } : p)));
  await syncPlaylists({ force: true });
  const here = byName('Mine, kept');
  assert.ok(here, 'my own playlist is never deleted from my laptop by the other one');
  assert.equal(here.shared, false);
  await syncPlaylists({ force: true });
  assert.equal(cloudPlaylists().find(p => p.uid === mine.uid).deleted, true, 'and it is not pushed back');
  await uploadsDone();
});

test('a playlist deleted here comes back if its owner edits it afterwards', async () => {
  const song = { title: a.title, artist: a.artist, album: a.album, duration: a.duration, isrc: null };
  writeCloudPlaylists([...cloudPlaylists(), { uid: 'u-late', name: 'Late edit', owner: 'Mum', updatedAt: Date.now(), songs: [song] }]);
  await syncPlaylists({ force: true });
  P.deletePlaylist(byName('Late edit').id);
  // Mum edits it before this laptop had a chance to tell the cloud.
  writeCloudPlaylists(cloudPlaylists().map(p => (p.uid === 'u-late' ? { ...p, name: 'Late edit 2', updatedAt: Date.now() + 20000 } : p)));
  await syncPlaylists({ force: true });
  assert.ok(byName('Late edit 2'), 'the newer edit wins over the older delete');
  assert.deepEqual(P.tombstones().filter(t => t.uid === 'u-late'), []);
});
