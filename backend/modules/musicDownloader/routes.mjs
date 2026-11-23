// Downloader API: POST /api/download {url, cloudOnly?} (cloudOnly: "Download to cloud"), GET /api/download/active, GET /api/jobs/:id, POST /api/jobs/:id/cancel,
//   GET /api/download/history, DELETE /api/download/history[/:id], GET /api/download/history/:id/report (text)
//   yt-dlp engine: GET /api/download/engine, PUT /api/download/engine {channel},
//                  POST /api/download/engine/update, POST /api/download/engine/rollback
// (update and rollback run in the background; poll GET /api/download/engine until `updating` is false)
import { readJson } from '../../core/http.mjs';
import { OFFLINE_MESSAGE, isConfigured, isOnline, loadSettings } from '../cloud/settings.mjs';
import { youtubeBlockedUntil } from './engine.mjs';
import { activeJob, cancelJob, deleteHistory, getJob, listHistory, startJob } from './jobs.mjs';
import { renderReport } from './report.mjs';
import { rollback, setChannel, status, update } from './updater.mjs';

const engineStatus = async () => ({ ...(await status()), youtubeBlockedUntil: youtubeBlockedUntil() || null });

/** Handles the request if it belongs to this module; returns true when it did. */
export async function handle(req, { json, res, cors }) {
  if (req.url === '/api/download/engine') {
    if (req.method === 'PUT') setChannel((await readJson(req, 1000)).channel);
    else if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return true; }
    json(200, await engineStatus());
    return true;
  }
  const engineAction = req.method === 'POST' && req.url.match(/^\/api\/download\/engine\/(update|rollback)$/);
  if (engineAction) {
    const action = engineAction[1] === 'update' ? update({ reason: 'manual' }) : rollback();
    action.catch(e => console.error(`yt-dlp ${engineAction[1]}:`, e.message));
    json(202, await engineStatus());
    return true;
  }
  if (req.method === 'POST' && req.url === '/api/download') {
    // The link is checked inside the job, so even a bad link ends up in the history with its explanation.
    const { url, cloudOnly } = await readJson(req, 10000);
    if (cloudOnly && !isConfigured(loadSettings())) {
      json(400, { error: 'Set up the cloud in Settings first (Cloud section).' });
      return true;
    }
    if (cloudOnly && !isOnline(loadSettings())) { json(400, { error: OFFLINE_MESSAGE }); return true; }
    const job = startJob(url, { cloudOnly });
    json(202, { jobId: job.id });
    return true;
  }
  if (req.method === 'GET' && req.url === '/api/download/active') {
    json(200, activeJob());
    return true;
  }
  const reportMatch = req.method === 'GET' && req.url.match(/^\/api\/download\/history\/([0-9a-f-]{36})\/report$/);
  if (reportMatch) {
    const job = listHistory().find(j => j.id === reportMatch[1]) || getJob(reportMatch[1]);
    if (!job) { json(404, { error: 'Unknown download' }); return true; }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(renderReport(job));
    return true;
  }
  const historyMatch = req.url.match(/^\/api\/download\/history(?:\/([0-9a-f-]{36}))?$/);
  if (historyMatch) {
    if (req.method === 'GET' && !historyMatch[1]) json(200, listHistory());
    else if (req.method === 'DELETE') json(200, { deleted: deleteHistory(historyMatch[1]) });
    else json(405, { error: 'Method not allowed' });
    return true;
  }
  const jobMatch = req.url.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/);
  if (jobMatch && ((req.method === 'GET' && !jobMatch[2]) || (req.method === 'POST' && jobMatch[2]))) {
    const job = getJob(jobMatch[1]);
    if (!job) json(404, { error: 'Unknown job' });
    else {
      if (jobMatch[2]) cancelJob(job.id);
      // The progress view polls this every second: leave out the (long) list of downloaded songs.
      json(200, { ...job, downloaded: undefined });
    }
    return true;
  }
  return false;
}
