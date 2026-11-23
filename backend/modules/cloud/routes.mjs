// Cloud API (songs on the LWS hosting, over FTP):
//   GET/PUT /api/cloud/settings, POST /api/cloud/test, GET /api/cloud/status
//   GET /api/cloud/songs, GET /api/cloud/songs/:id/stream (Range), GET /api/cloud/songs/:id/cover,
//   POST /api/cloud/songs/:id/prefetch, DELETE /api/cloud/songs/:id, POST /api/cloud/rebuild
//   POST /api/cloud/folder/pick, POST /api/cloud/folder/scan {path}
//   PUT /api/cloud/playlists/:id/share {shared}, POST /api/cloud/playlists/sync {force?}
//   POST /api/cloud/upload {trackIds|paths}, GET /api/cloud/upload/active, GET /api/cloud/upload/:id,
//   POST /api/cloud/upload/:id/cancel
import { coverOf } from '../../core/library.mjs';
import { readJson, streamFile } from '../../core/http.mjs';
import { fetchSong, localSource, touch } from './cache.mjs';
import { testConnection } from './remote.mjs';
import { isConfigured, loadSettings, publicSettings, saveSettings } from './settings.mjs';
import { cloudStatus, lastIndex, rebuildIndex, withCloud } from './store.mjs';
import { setShared } from '../musicPlayer/playlists.mjs';
import { ownerName, requestSync, syncPlaylists } from './playlistSync.mjs';
import { activeUpload, cancelUpload, getUpload, pickFolder, scanFolder, startUpload } from './upload.mjs';

/** A cloud song by id, from the local copy of the index (no network for every Range request of the player). */
async function findSong(id) {
  const known = lastIndex()?.songs.find(s => s.id === id);
  if (known) return known;
  return (await withCloud(c => c.index())).songs.find(s => s.id === id);
}

const withLaptopFlag = songs => songs.map(s => {
  const here = localSource(s);
  return { ...s, onLaptop: Boolean(here), inLibrary: here?.from === 'library' };
});
/** Settings for the page: no password, plus the name shown on playlists this laptop shares. */
const forPage = s => ({ ...publicSettings(s), displayName: ownerName(s) });

/** Handles the request if it belongs to this module; returns true when it did. */
export async function handle(req, { res, json, cors }) {
  if (!req.url.startsWith('/api/cloud/')) return false;
  const url = req.url.split('?')[0];
  const method = req.method;

  if (url === '/api/cloud/settings') {
    if (method === 'GET') json(200, forPage(loadSettings()));
    else if (method === 'PUT') json(200, forPage(saveSettings(await readJson(req, 5000))));
    else json(405, { error: 'Method not allowed' });
    return true;
  }
  if (method === 'POST' && url === '/api/cloud/test') { json(200, await testConnection(loadSettings())); return true; }
  if (method === 'GET' && url === '/api/cloud/status') { json(200, await cloudStatus()); return true; }
  if (method === 'POST' && url === '/api/cloud/rebuild') { json(200, await rebuildIndex()); return true; }

  if (method === 'GET' && url === '/api/cloud/songs') {
    try {
      const index = await withCloud(c => c.index());
      json(200, { songs: withLaptopFlag(index.songs), offline: false });
    } catch (e) {
      // Cloud unreachable: show the last known list; songs on this laptop still play.
      json(200, { songs: withLaptopFlag(lastIndex()?.songs ?? []), offline: true, error: e.message });
    }
    return true;
  }

  const songMatch = url.match(/^\/api\/cloud\/songs\/(\d+)(?:\/(stream|cover|prefetch))?$/);
  if (songMatch) {
    const id = Number(songMatch[1]);
    const action = songMatch[2];
    if (!action && method === 'DELETE') {
      const removed = await withCloud(c => c.removeSong(id));
      if (removed) json(200, { deleted: id });
      else json(404, { error: 'This song is not on the cloud.' });
      return true;
    }
    const song = await findSong(id);
    if (!song) { json(404, { error: 'This song is not on the cloud.' }); return true; }
    if (action === 'prefetch' && method === 'POST') {
      fetchSong(song).catch(() => { /* playing it later will show the reason */ });
      json(202, { prefetching: id });
      return true;
    }
    if (action === 'cover' && method === 'GET') {
      const here = localSource(song);
      const cover = here && await coverOf(here.path);
      if (!cover) { json(404, { error: 'No cover on this laptop.' }); return true; }
      res.writeHead(200, { ...cors, 'Content-Type': cover.type, 'Cache-Control': 'max-age=86400' });
      res.end(cover.data);
      return true;
    }
    if (action === 'stream' && method === 'GET') {
      let path;
      try {
        const here = localSource(song);
        if (here?.from === 'cache') touch(song);
        path = here?.path ?? await fetchSong(song);
      } catch (e) {
        json(502, { error: e.message.replace(/^Cloud: /, '') });
        return true;
      }
      await streamFile(req, res, path, cors);
      return true;
    }
    json(405, { error: 'Method not allowed' });
    return true;
  }

  if (method === 'POST' && url === '/api/cloud/playlists/sync') {
    json(200, await requestSync({ force: Boolean((await readJson(req, 1000)).force) }));
    return true;
  }
  const shareMatch = method === 'PUT' && url.match(/^\/api\/cloud\/playlists\/(\d+)\/share$/);
  if (shareMatch) {
    const shared = Boolean((await readJson(req, 1000)).shared);
    const settings = loadSettings();
    if (shared && !isConfigured(settings)) { json(400, { error: 'Set up the cloud in Settings first.' }); return true; }
    const playlist = setShared(Number(shareMatch[1]), shared, ownerName(settings));
    if (!playlist) { json(404, { error: 'Unknown playlist' }); return true; }
    await syncPlaylists({ settings }).catch(e => console.error('Playlist sync:', e.message));
    json(200, playlist);
    return true;
  }

  if (method === 'POST' && url === '/api/cloud/folder/pick') { json(200, { path: await pickFolder() }); return true; }
  if (method === 'POST' && url === '/api/cloud/folder/scan') {
    json(200, { songs: await scanFolder(String((await readJson(req, 5000)).path ?? '')) });
    return true;
  }

  if (method === 'POST' && url === '/api/cloud/upload') {
    const body = await readJson(req, 2_000_000);
    try {
      const job = startUpload({ trackIds: body.trackIds ?? [], paths: body.paths ?? [] });
      json(202, { jobId: job.id });
    } catch (e) {
      json(409, { error: e.message });
    }
    return true;
  }
  if (method === 'GET' && url === '/api/cloud/upload/active') { json(200, activeUpload()); return true; }
  const jobMatch = url.match(/^\/api\/cloud\/upload\/([0-9a-f-]{36})(\/cancel)?$/);
  if (jobMatch) {
    const job = getUpload(jobMatch[1]);
    if (!job) { json(404, { error: 'Unknown upload' }); return true; }
    if (jobMatch[2] && method === 'POST') cancelUpload(job.id);
    json(200, job);
    return true;
  }
  json(404, { error: 'Not found' });
  return true;
}
