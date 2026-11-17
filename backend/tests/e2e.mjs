// End-to-end check of all three flows against a RUNNING server (node server.mjs).
// Usage: node e2e.mjs        (downloads 3 small files into ../downloadedMusic)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { outputDir } from '../core/config.mjs';

const API = process.env.API || 'http://127.0.0.1:3000/api';
const cases = [
  { name: 'YouTube video', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  { name: 'Spotify track', url: 'https://open.spotify.com/track/3h5T5JypYU7huFiVYhv1dr' },
  { name: 'Deezer track', url: 'https://www.deezer.com/track/3135553' },
];

async function runCase({ name, url }) {
  const start = await fetch(`${API}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const started = await start.json();
  if (!start.ok) return { name, ok: false, detail: started.error };
  for (;;) {
    const job = await (await fetch(`${API}/jobs/${started.jobId}`)).json();
    if (job.status === 'running') { await new Promise(r => setTimeout(r, 1500)); continue; }
    const files = job.files.filter(f => existsSync(f));
    const ok = job.status === 'done' && files.length === job.files.length && files.length > 0;
    return { name, ok, detail: ok ? files.map(f => f.replace(outputDir + '\\', '')).join(', ') : (job.error || JSON.stringify(job.failed)) };
  }
}

let failed = 0;
for (const c of cases) {
  const r = await runCase(c);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(failed ? `${failed} of ${cases.length} failed` : 'All flows work.');
process.exit(failed ? 1 : 0);
