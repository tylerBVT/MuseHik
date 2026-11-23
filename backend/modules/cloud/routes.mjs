// Cloud API (songs on the LWS hosting, over FTP):
//   GET/PUT /api/cloud/settings, POST /api/cloud/test, GET /api/cloud/status
//   GET /api/cloud/songs, GET /api/cloud/songs/:id/stream (Range), GET /api/cloud/songs/:id/cover,
//   POST /api/cloud/songs/:id/prefetch, PATCH /api/cloud/songs/:id {title?, artist?, genre?}, DELETE /api/cloud/songs/:id,
//   POST /api/cloud/rebuild
//   POST /api/cloud/folder/pick, POST /api/cloud/folder/scan {path}
//   PUT /api/cloud/playlists/:id/share {shared}, POST /api/cloud/playlists/sync {force?}
//   POST /api/cloud/upload {trackIds|paths, queue?} (queue: wait behind a running upload), GET /api/cloud/upload/active, GET /api/cloud/upload/:id,
//   POST /api/cloud/upload/:id/cancel
//   POST /api/cloud/save {ids} ("Download from cloud"), GET /api/cloud/save/active, GET /api/cloud/save/:id,
//   POST /api/cloud/save/:id/cancel
import { coverOf } from '../../core/library.mjs';
import { readJson, streamFile, streamGrowing } from '../../core/http.mjs';
import { fetchSong, localSource, startFetch, touch } from './cache.mjs';
import { testConnection } from './remote.mjs';
import { OFFLINE_MESSAGE, isConfigured, isOnline, loadSettings, publicSettings, saveSettings } from './settings.mjs';
import { EditError, cloudStatus, lastIndex, rebuildIndex, syncFolder, withCloud } from './store.mjs';
import { renameSongEverywhere, setShared } from '../musicPlayer/playlists.mjs';
import { ownerName, requestSync, syncPlaylists } from './playlistSync.mjs';
import { activeSave, cancelSave, getSave, startSave } from './save.mjs';
import { activeUpload, cancelUpload, getUpload, pickFolder, queueUpload, scanFolder, startUpload } from './upload.mjs';

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
    if (!isOnline(loadSettings())) {
      // Offline laptop: the last list it saw, without connecting. Songs on this laptop still play.
      json(200, { songs: withLaptopFlag(lastIndex()?.songs ?? []), offline: true, mode: 'offline' });
      return true;
    }
    try {
      // Songs added to songs/ by hand (FileZilla...) join the list; songs deleted by hand leave it.
      const index = await withCloud(async c => { await syncFolder(c); return c.index(); });
      json(200, { songs: withLaptopFlag(index.songs), offline: false, mode: 'online' });
    } catch (e) {
      // Cloud unreachable: show the last known list; songs on this laptop still play.
      json(200, { songs: withLaptopFlag(lastIndex()?.songs ?? []), offline: true, mode: 'online', error: e.message });
    }
    return true;
  }

  const songMatch = url.match(/^\/api\/cloud\/songs\/(\d+)(?:\/(stream|cover|prefetch))?$/);
  if (songMatch) {
    const id = Number(songMatch[1]);
    const action = songMatch[2];
    if (!action && method === 'PATCH') {
      const changes = await readJson(req, 5000);
      try {
        // Files added by hand are listed first, so a rename never takes the name of one of them.
        const result = await withCloud(async c => {
          await syncFolder(c);
          const before = (await c.index()).songs.find(s => s.id === id);
          return before ? { before, after: await c.editSong(id, changes) } : null;
        });
        if (!result) { json(404, { error: 'This song is not on the cloud.' }); return true; }
        renameSongEverywhere(result.before, result.after);
        json(200, result.after);
      } catch (e) {
        json(e instanceof EditError || /^Cloud: /.test(e.message) ? 400 : 500, { error: e.message.replace(/^Cloud: /, '') });
      }
      return true;
    }
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
      const here = localSource(song);
      if (here) {
        if (here.from === 'cache') touch(song);
        await streamFile(req, res, here.path, cors);
        return true;
      }
      // Not on this laptop: play it while it downloads (the download becomes the cached copy).
      let path = null;
      const download = startFetch(song);
      try {
        await download.ready;
        if (download.error) throw download.error;
        if (download.done) path = download.target;
        else if (!download.size) path = await download.promise; // size unknown: wait for the whole song
      } catch (e) {
        json(502, { error: e.message.replace(/^Cloud: /, '') });
        return true;
      }
      if (path) await streamFile(req, res, path, cors);
      else await streamGrowing(req, res, download, cors);
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
    if (shared && !isOnline(settings)) { json(400, { error: OFFLINE_MESSAGE }); return true; }
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
    const selection = { trackIds: body.trackIds ?? [], paths: body.paths ?? [] };
    try {
      if (body.queue) json(202, queueUpload(selection));
      else json(202, { jobId: startUpload(selection).id });
    } catch (e) {
      json(409, { error: e.message });
    }
    return true;
  }
  if (method === 'GET' && url === '/api/cloud/upload/active') { json(200, activeUpload()); return true; }

  if (method === 'POST' && url === '/api/cloud/save') {
    const ids = (await readJson(req, 200_000)).ids;
    if (!Array.isArray(ids) || !ids.length) { json(400, { error: 'Choose at least one song.' }); return true; }
    try {
      json(202, { jobId: startSave(ids).id });
    } catch (e) {
      json(409, { error: e.message });
    }
    return true;
  }
  if (method === 'GET' && url === '/api/cloud/save/active') { json(200, activeSave()); return true; }
  const saveMatch = url.match(/^\/api\/cloud\/save\/([0-9a-f-]{36})(\/cancel)?$/);
  if (saveMatch) {
    const job = getSave(saveMatch[1]);
    if (!job) { json(404, { error: 'Unknown save' }); return true; }
    if (saveMatch[2] && method === 'POST') cancelSave(job.id);
    json(200, job);
    return true;
  }
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
