// Dev-only local server. Link -> background job -> audio files in ONE flat folder (config.json "musicDir"),
// indexed in SQLite (library.mjs). Also serves the library to the player (list, audio stream, cover art).
// Flow (same idea as OpenCrate/spotDL): a platform service reads the track list, the library says which songs
// we already have, the engine finds the rest on YouTube with yt-dlp, downloads them as MP3 and tags them.
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { detect } from './services/index.mjs';
import { downloadAudio, findOnYoutube, outputDir, python, tagFile } from './engine.mjs';
import { fileBase, trackKey } from './lib.mjs';
import {
  addFile, coverOf, createPlaylist, deletePlaylist, findDuplicate, getPlaylist, getTrack, listPlaylists, listTracks,
  scanLibrary, updatePlaylist,
} from './library.mjs';

const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set(['http://localhost:4200', 'http://127.0.0.1:4200']);
const MAX_TRACKS = 200;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav' };

// ---------- Jobs ----------
const jobs = new Map();
const controllers = new Map(); // jobId -> AbortController (kept out of the job so the job stays JSON-serialisable)

const youtubeSource = url => `youtube:${new URL(url).searchParams.get('v')}`;

/** First free "<base>.mp3" name: never overwrites a different song that happens to share the name. */
function freeBase(base) {
  let candidate = base;
  for (let n = 2; existsSync(join(outputDir, `${candidate}.mp3`)); n++) candidate = `${base} (${n})`;
  return candidate;
}

/**
 * Downloads one track into the flat folder.
 * Returns { file } when downloaded, { skipped: reason } when the song is already there.
 * `claimed` holds keys being downloaded by this job, so a song listed twice is fetched once.
 */
async function downloadTrack(track, claimed, signal, onBase) {
  const direct = Boolean(track.sourceUrl); // YouTube link: no search, keep yt-dlp's own tags
  const key = track.title ? trackKey(track.artist, track.title) : null;
  const dup = findDuplicate({ ...track, source: direct ? youtubeSource(track.sourceUrl) : undefined });
  if (dup) return { skipped: `Already in your library as "${dup.artist ? `${dup.artist} - ` : ''}${dup.title}"` };
  if (key) {
    if (claimed.has(key)) return { skipped: 'Listed twice in this playlist' };
    claimed.add(key);
  }

  let source = track.sourceUrl;
  if (!direct) {
    source = await findOnYoutube(track, signal);
    const same = findDuplicate({ source: youtubeSource(source) });
    if (same) return { skipped: `Already in your library as "${same.artist ? `${same.artist} - ` : ''}${same.title}"` };
  }

  const base = track.title ? freeBase(fileBase(direct ? '' : track.artist, track.title)) : null;
  onBase(base);
  const template = base ? `${base}.%(ext)s` : '%(artist,uploader)s - %(title)s.%(ext)s';
  const file = await downloadAudio(source, join(outputDir, template), signal);
  if (!direct) await tagFile(file, track, signal);
  await addFile(file, youtubeSource(source));
  return { file };
}

/** After Stop or a failure: remove leftovers (thumbnails, partial files) of one unfinished track. */
async function cleanupUnfinished(bases, settleMs = 700) {
  const prefixes = bases.filter(Boolean).map(b => `${b}.`);
  if (!prefixes.length) return;
  await new Promise(r => setTimeout(r, settleMs)); // let killed child processes release their files
  for (const name of await readdir(outputDir)) {
    if (prefixes.some(p => name.startsWith(p))) await rm(join(outputDir, name), { force: true }).catch(() => {});
  }
}

async function processJob(job, { service, ref }, signal) {
  try {
    job.current = `Reading ${service.label} link...`;
    const collection = await service.resolve(ref);
    const tracks = collection.tracks.slice(0, MAX_TRACKS);
    job.name = collection.name;
    job.total = tracks.length;
    if (collection.tracks.length > MAX_TRACKS) job.warning = `Only the first ${MAX_TRACKS} tracks are downloaded.`;
    await mkdir(outputDir, { recursive: true });

    // Each finished file stays on disk (and in the index) immediately, so stopping keeps all progress.
    const queue = [...tracks];
    const claimed = new Set();
    const inFlight = new Map(); // track -> file base name (for cleanup)
    const worker = async () => {
      for (let track; !signal.aborted && (track = queue.shift());) {
        const label = track.sourceUrl && !track.title ? track.sourceUrl : `${track.artist} - ${track.title}`;
        job.current = label;
        inFlight.set(track, null);
        try {
          const result = await downloadTrack(track, claimed, signal, base => inFlight.set(track, base));
          inFlight.delete(track);
          if (result.file) job.files.push(result.file);
          else { job.skippedList.push({ track: label, reason: result.skipped }); job.skipped++; }
          job.done++;
        } catch (e) {
          if (signal.aborted) return;
          await cleanupUnfinished([inFlight.get(track)], 0);
          inFlight.delete(track);
          job.failed.push({ track: label, error: e.message });
          job.done++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));

    if (signal.aborted) {
      await cleanupUnfinished([...inFlight.values()]);
      job.status = 'cancelled';
    } else {
      const ok = job.files.length + job.skipped > 0;
      job.status = ok ? 'done' : 'error';
      if (!ok) job.error = job.failed[0]?.error || 'Nothing was downloaded.';
    }
  } catch (e) {
    job.status = signal.aborted ? 'cancelled' : 'error';
    if (!signal.aborted) job.error = e.message;
  }
  job.current = '';
  controllers.delete(job.id);
}

function startJob(detected) {
  const job = {
    id: randomUUID(), platform: detected.service.id, status: 'running', name: '', total: 0, done: 0, skipped: 0,
    current: '', files: [], skippedList: [], failed: [], folder: outputDir,
  };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  void processJob(job, detected, controller.signal);
  return job;
}

// ---------- HTTP ----------
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

/** Reads a small JSON request body. */
async function readJson(req) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > 200000) throw new Error('Request too large.');
  }
  return JSON.parse(raw || '{}');
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = allowedOrigins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin',
      }
    : {};
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };
  if (origin && !allowedOrigins.has(origin)) return json(403, { error: 'Invalid origin' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    if (req.method === 'POST' && req.url === '/api/download') {
      let raw = '';
      for await (const part of req) {
        raw += part;
        if (raw.length > 10000) throw new Error('Request too large.');
      }
      const job = startJob(detect(JSON.parse(raw || '{}').url));
      return json(202, { jobId: job.id, platform: job.platform });
    }
    const jobMatch = req.url.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/);
    if (jobMatch && ((req.method === 'GET' && !jobMatch[2]) || (req.method === 'POST' && jobMatch[2]))) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(404, { error: 'Unknown job' });
      if (jobMatch[2]) controllers.get(job.id)?.abort();
      return json(200, job);
    }

    // Playlists: GET list, POST create, GET/PUT/DELETE one.
    if (req.url === '/api/playlists' && req.method === 'GET') return json(200, listPlaylists());
    if (req.url === '/api/playlists' && req.method === 'POST') {
      const body = await readJson(req);
      return json(201, createPlaylist(body.name, body.trackIds));
    }
    const listMatch = req.url.match(/^\/api\/playlists\/(\d+)$/);
    if (listMatch) {
      const id = Number(listMatch[1]);
      let result;
      if (req.method === 'GET') result = getPlaylist(id);
      else if (req.method === 'PUT') { const body = await readJson(req); result = updatePlaylist(id, body.name, body.trackIds); }
      else if (req.method === 'DELETE') result = deletePlaylist(id) ? { deleted: id } : undefined;
      else return json(405, { error: 'Method not allowed' });
      return result ? json(200, result) : json(404, { error: 'Unknown playlist' });
    }

    if (req.method === 'GET' && req.url === '/api/library') return json(200, listTracks());
    if (req.method === 'POST' && req.url === '/api/library/rescan') return json(200, await scanLibrary());
    const trackMatch = req.method === 'GET' && req.url.match(/^\/api\/library\/(\d+)\/(stream|cover)(?:\?.*)?$/);
    if (trackMatch) {
      const track = getTrack(Number(trackMatch[1]));
      if (!track || !existsSync(track.path)) return json(404, { error: 'Track not found' });
      if (trackMatch[2] === 'stream') return await streamFile(req, res, track.path, cors);
      const cover = await coverOf(track.path);
      if (!cover) return json(404, { error: 'No cover art' });
      res.writeHead(200, { ...cors, 'Content-Type': cover.type, 'Cache-Control': 'max-age=86400' });
      return res.end(cover.data);
    }
    json(404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(400, { error: e.message });
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(python)) console.warn(`Python venv missing at ${python}`);
  const scan = await scanLibrary();
  console.log(`Library: ${scan.total} tracks (${scan.added} new, ${scan.removed} removed)`);
  server.listen(port, '127.0.0.1', () => console.log(`Server on http://127.0.0.1:${port}, saving to ${outputDir}`));
}
