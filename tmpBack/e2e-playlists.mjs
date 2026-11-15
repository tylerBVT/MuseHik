// Full-playlist end-to-end check against a RUNNING server (start it with MUSIC_DIR set if you do not
// want ~3 GB inside OneDrive).  Usage: node e2e-playlists.mjs
// Runs the playlists one after another and prints progress, then a per-playlist summary.
import { existsSync, readdirSync } from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:3000/api';
const playlists = [
  { name: 'Deezer "phil harmonie"', url: 'https://www.deezer.com/fr/playlist/14093104361' },
  { name: 'Spotify "Dance Party"', url: 'https://open.spotify.com/playlist/37i9dQZF1DXaXB8fQg7xif' },
  { name: 'YouTube "Teen Party Music"', url: 'https://www.youtube.com/playlist?list=PLC_T_5B6fsPfjRfi_AcPICITM1TEVWJL9' },
];
const wait = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

async function runPlaylist({ name, url }) {
  const start = await fetch(`${API}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const started = await start.json();
  if (!start.ok) return { name, ok: false, detail: started.error };
  let last = 0;
  for (;;) {
    const job = await (await fetch(`${API}/jobs/${started.jobId}`)).json();
    if (Date.now() - last > 30000) {
      console.log(`[${stamp()}] ${name}: ${job.done}/${job.total} (${job.failed.length} failed)`);
      last = Date.now();
    }
    if (job.status !== 'running') return { name, job };
    await wait(2000);
  }
}

let problems = 0;
for (const p of playlists) {
  const r = await runPlaylist(p);
  if (!r.job) { console.log(`FAIL  ${r.name}: ${r.detail}`); problems++; continue; }
  const { job } = r;
  const missing = job.files.filter(f => !existsSync(f));
  const files = job.files.length + job.skipped;
  const ok = job.status === 'done' && missing.length === 0 && files >= job.total * 0.8;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name} -> "${job.name}": ${files}/${job.total} downloaded, ${job.failed.length} failed, ${missing.length} missing on disk`);
  for (const f of job.failed.slice(0, 8)) console.log(`        - ${f.track}: ${f.error.slice(0, 110)}`);
  if (!ok) problems++;
}
console.log(problems ? `${problems} playlist(s) had problems` : 'All playlists OK (>= 80% of tracks each).');
process.exit(problems ? 1 : 0);
