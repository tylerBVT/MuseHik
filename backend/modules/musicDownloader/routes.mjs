// Downloader API: POST /api/download, GET /api/jobs/:id, POST /api/jobs/:id/cancel
import { readJson } from '../../core/http.mjs';
import { cancelJob, getJob, startJob } from './jobs.mjs';
import { detect } from './services/index.mjs';

/** Handles the request if it belongs to this module; returns true when it did. */
export async function handle(req, { json }) {
  if (req.method === 'POST' && req.url === '/api/download') {
    const job = startJob(detect((await readJson(req, 10000)).url));
    json(202, { jobId: job.id, platform: job.platform });
    return true;
  }
  const jobMatch = req.url.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/);
  if (jobMatch && ((req.method === 'GET' && !jobMatch[2]) || (req.method === 'POST' && jobMatch[2]))) {
    const job = getJob(jobMatch[1]);
    if (!job) json(404, { error: 'Unknown job' });
    else {
      if (jobMatch[2]) cancelJob(job.id);
      json(200, job);
    }
    return true;
  }
  return false;
}
