// Dev-only local server. Link -> background job -> MP3 files in ../downloadedMusic.
// Flow (same idea as OpenCrate/spotDL): a platform service reads the track list, the engine finds
// each track's audio on YouTube with yt-dlp, downloads it as MP3 and tags it.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { detect } from './services/index.mjs';
import { downloadAudio, findOnYoutube, outputDir, python, tagFile } from './engine.mjs';
import { safeName, trackFilename } from './lib.mjs';

const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set(['http://localhost:4200', 'http://127.0.0.1:4200']);
const MAX_TRACKS = 200;

// ---------- Jobs ----------
const jobs = new Map();

async function processJob(job, { service, ref }) {
  try {
    job.current = `Reading ${service.label} link...`;
    const collection = await service.resolve(ref);
    const tracks = collection.tracks.slice(0, MAX_TRACKS);
    job.name = collection.name;
    job.total = tracks.length;
    if (collection.tracks.length > MAX_TRACKS) job.warning = `Only the first ${MAX_TRACKS} tracks are downloaded.`;
    const folder = collection.type === 'track' ? outputDir : join(outputDir, safeName(collection.name));
    await mkdir(folder, { recursive: true });

    for (const track of tracks) {
      job.current = track.sourceUrl || `${track.artist} - ${track.title}`;
      try {
        if (track.sourceUrl) {
          // Direct source (YouTube link): no search, keep yt-dlp's own tags.
          job.files.push(await downloadAudio(track.sourceUrl, join(folder, '%(artist,uploader)s - %(title)s.%(ext)s')));
        } else {
          const source = await findOnYoutube(track);
          const file = await downloadAudio(source, join(folder, `${trackFilename(track, tracks.length)}.%(ext)s`));
          await tagFile(file, track);
          job.files.push(file);
        }
      } catch (e) {
        job.failed.push({ track: job.current, error: e.message });
      }
      job.done++;
    }
    job.status = job.files.length ? 'done' : 'error';
    if (!job.files.length) job.error = job.failed[0]?.error || 'Nothing was downloaded.';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  }
  job.current = '';
}

function startJob(detected) {
  const job = {
    id: randomUUID(), platform: detected.service.id, status: 'running', name: '', total: 0, done: 0,
    current: '', files: [], failed: [], folder: outputDir,
  };
  jobs.set(job.id, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  void processJob(job, detected);
  return job;
}

// ---------- HTTP ----------
export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = allowedOrigins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST',
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
    const m = req.method === 'GET' && req.url.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (m) {
      const job = jobs.get(m[1]);
      return job ? json(200, job) : json(404, { error: 'Unknown job' });
    }
    json(404, { error: 'Not found' });
  } catch (e) {
    json(400, { error: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(python)) console.warn(`Python venv missing at ${python}`);
  server.listen(port, '127.0.0.1', () => console.log(`Server on http://127.0.0.1:${port}, saving to ${outputDir}`));
}
