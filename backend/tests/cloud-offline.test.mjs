import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

// A laptop set up for the cloud but switched to Offline: nothing may connect.
const tmp = mkdtempSync(join(tmpdir(), 'musehik-offline-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { server } = await import('../server.mjs');
const { isOnline, loadSettings, saveSettings } = await import('../modules/cloud/settings.mjs');
const { withCloud } = await import('../modules/cloud/store.mjs');
const { syncPlaylists } = await import('../modules/cloud/playlistSync.mjs');
const { createPlaylist } = await import('../modules/musicPlayer/playlists.mjs');

let remote, base;
before(async () => {
  remote = await startCloud();
  
  saveSettings({ ...remote.settings, online: false });
  // What this laptop saw the last time it was online.
  writeFileSync(join(tmp, 'cloud-library.json'), JSON.stringify({
    version: 1, nextId: 2, songs: [{ id: 1, file: 'A - B.mp3', title: 'B', artist: 'A', album: '', duration: 100, size: 10 }],
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server.close(); await remote.close(); });

const api = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

test('the online switch is saved, on by default', () => {
  assert.equal(loadSettings().online, false);
  assert.equal(isOnline(loadSettings()), false);
  assert.equal(isOnline({ ...loadSettings(), online: true }), true);
  assert.equal(isOnline({ ...loadSettings(), online: true, key: '' }), false, 'not set up = not online');
});

test('offline: withCloud refuses without connecting', async () => {
  await assert.rejects(withCloud(c => c.index()), /offline on this laptop/);
  assert.equal(remote.requests, 0);
});

test('offline: status, song list, sync and sharing never connect', async () => {
  const status = await api('/cloud/status');
  assert.deepEqual(status.body, { configured: true, online: false });

  const songs = await api('/cloud/songs');
  assert.equal(songs.status, 200);
  assert.equal(songs.body.offline, true);
  assert.equal(songs.body.mode, 'offline');
  assert.deepEqual(songs.body.songs.map(s => s.title), ['B'], 'the last known list');

  assert.equal((await syncPlaylists()).skipped, true);
  const sync = await api('/cloud/playlists/sync', { method: 'POST', body: { force: true } });
  assert.equal(sync.body.skipped, true);

  const playlist = createPlaylist('Mine', []);
  const share = await api(`/cloud/playlists/${playlist.id}/share`, { method: 'PUT', body: { shared: true } });
  assert.equal(share.status, 400);
  assert.match(share.body.error, /offline/);

  const download = await api('/download', { method: 'POST', body: { url: 'https://example.com/x', cloudOnly: true } });
  assert.equal(download.status, 400);
  assert.equal(remote.requests, 0, 'no connection at all');
});

test('the Test connection button still works offline (asked for by hand)', async () => {
  const { body } = await api('/cloud/test', { method: 'POST' });
  assert.equal(body.ok, true);
});
