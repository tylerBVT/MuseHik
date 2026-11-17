// Instrumental separator API:
//   GET    /api/separator/methods                      the three methods (+ whether the separator is installed)
//   GET    /api/separator/tracks/:id                   finished instrumentals of a song + its running job, if any
//   GET    /api/separator/tracks/:id/:method/audio     play one (HTTP Range); add ?download=1 to save it
//   DELETE /api/separator/tracks/:id/:method           delete one
//   POST   /api/separator/jobs  { trackId, method }    make one (queued; one at a time on the GPU)
//   GET    /api/separator/jobs/:id                     progress
//   POST   /api/separator/jobs/:id/cancel              stop
import { existsSync } from 'node:fs';
import { readJson, streamFile } from '../../core/http.mjs';
import { getTrack } from '../../core/library.mjs';
import {
  activeJobFor, available, cancelJob, deleteResult, getJob, methods, resultPath, resultsFor, startJob,
} from './jobs.mjs';

export async function handle(req, { res, json, cors }) {
  if (!req.url.startsWith('/api/separator/')) return false;
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/separator/methods') {
    json(200, {
      available: available(),
      methods: methods.map(({ id, name, summary, description }) => ({ id, name, summary, description })),
    });
    return true;
  }

  const trackMatch = path.match(/^\/api\/separator\/tracks\/(\d+)(?:\/([a-z]+)(?:\/(audio))?)?$/);
  if (trackMatch) {
    const track = getTrack(Number(trackMatch[1]));
    if (!track) { json(404, { error: 'Track not found' }); return true; }
    const [, , method, audio] = trackMatch;
    if (!method && req.method === 'GET') {
      json(200, { results: await resultsFor(track), job: activeJobFor(track.id) });
      return true;
    }
    if (method && audio && req.method === 'GET') {
      const file = resultPath(track, method);
      if (!existsSync(file)) { json(404, { error: 'No instrumental made with this method yet' }); return true; }
      const headers = { ...cors };
      if (url.searchParams.get('download')) {
        const name = `${track.artist ? `${track.artist} - ` : ''}${track.title} (Instrumental${method === 'backing' ? ' + BV' : ''}).mp3`;
        headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      }
      await streamFile(req, res, file, headers);
      return true;
    }
    if (method && !audio && req.method === 'DELETE') {
      if (await deleteResult(track, method)) json(200, { deleted: method });
      else json(404, { error: 'Nothing to delete' });
      return true;
    }
    json(405, { error: 'Method not allowed' });
    return true;
  }

  if (req.method === 'POST' && path === '/api/separator/jobs') {
    const body = await readJson(req);
    json(202, startJob(Number(body.trackId), String(body.method)));
    return true;
  }
  const jobMatch = path.match(/^\/api\/separator\/jobs\/([\w-]+)(\/cancel)?$/);
  if (jobMatch) {
    const job = jobMatch[2] ? (req.method === 'POST' ? cancelJob(jobMatch[1]) : undefined) : (req.method === 'GET' ? getJob(jobMatch[1]) : undefined);
    if (job) json(200, job);
    else json(404, { error: 'Unknown job' });
    return true;
  }
  return false;
}
