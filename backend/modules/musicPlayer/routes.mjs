// Player API: the library list, audio streaming (with seeking), cover art, and playlists.
//   GET /api/library, POST /api/library/rescan, GET /api/library/:id/stream, GET /api/library/:id/cover
//   GET/POST /api/playlists, GET/PUT/DELETE /api/playlists/:id
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { readJson } from '../../core/http.mjs';
import { coverOf, getTrack, listTracks, scanLibrary } from '../../core/library.mjs';
import { createPlaylist, deletePlaylist, getPlaylist, listPlaylists, updatePlaylist } from './playlists.mjs';

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav' };

/** Serves a file with HTTP Range support, which <audio> needs for seeking. */
async function streamFile(req, res, path, headers) {
  const { size } = await stat(path);
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return createReadStream(path).pipe(res);
  }
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
  end = Math.min(end, size - 1);
  if (!(start >= 0) || start > end) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...headers, 'Content-Type': type, 'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
  });
  createReadStream(path, { start, end }).pipe(res);
}

/** Handles the request if it belongs to this module; returns true when it did. */
export async function handle(req, { res, json, cors }) {
  // Playlists: GET list, POST create, GET/PUT/DELETE one.
  if (req.url === '/api/playlists' && req.method === 'GET') { json(200, listPlaylists()); return true; }
  if (req.url === '/api/playlists' && req.method === 'POST') {
    const body = await readJson(req);
    json(201, createPlaylist(body.name, body.trackIds));
    return true;
  }
  const listMatch = req.url.match(/^\/api\/playlists\/(\d+)$/);
  if (listMatch) {
    const id = Number(listMatch[1]);
    let result;
    if (req.method === 'GET') result = getPlaylist(id);
    else if (req.method === 'PUT') { const body = await readJson(req); result = updatePlaylist(id, body.name, body.trackIds); }
    else if (req.method === 'DELETE') result = deletePlaylist(id) ? { deleted: id } : undefined;
    else { json(405, { error: 'Method not allowed' }); return true; }
    if (result) json(200, result);
    else json(404, { error: 'Unknown playlist' });
    return true;
  }

  // Library: list, rescan, stream, cover.
  if (req.method === 'GET' && req.url === '/api/library') { json(200, listTracks()); return true; }
  if (req.method === 'POST' && req.url === '/api/library/rescan') { json(200, await scanLibrary()); return true; }
  const trackMatch = req.method === 'GET' && req.url.match(/^\/api\/library\/(\d+)\/(stream|cover)(?:\?.*)?$/);
  if (trackMatch) {
    const track = getTrack(Number(trackMatch[1]));
    if (!track || !existsSync(track.path)) { json(404, { error: 'Track not found' }); return true; }
    if (trackMatch[2] === 'stream') { await streamFile(req, res, track.path, cors); return true; }
    const cover = await coverOf(track.path);
    if (!cover) { json(404, { error: 'No cover art' }); return true; }
    res.writeHead(200, { ...cors, 'Content-Type': cover.type, 'Cache-Control': 'max-age=86400' });
    res.end(cover.data);
    return true;
  }
  return false;
}
