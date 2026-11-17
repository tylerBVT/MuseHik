// Checks the Stop button logic against a RUNNING server: starts a playlist, stops after N finished tracks,
// then verifies finished MP3s were kept and no half-downloaded leftovers remain.
// Usage: node e2e-stop.mjs [playlist-url] [tracks-before-stop]
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API || 'http://127.0.0.1:3000/api';
const url = process.argv[2] || 'https://www.deezer.com/fr/playlist/14093104361';
const stopAfter = Number(process.argv[3] || 4);
const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
}).then(r => r.json());
const get = path => fetch(`${API}${path}`).then(r => r.json());
const wait = ms => new Promise(r => setTimeout(r, ms));

const { jobId, error } = await post('/download', { url });
if (error) { console.log('FAIL start:', error); process.exit(1); }

let job;
do { await wait(1000); job = await get(`/jobs/${jobId}`); }
while (job.status === 'running' && job.done < stopAfter);

console.log(`Stopping at ${job.done}/${job.total} done...`);
await post(`/jobs/${jobId}/cancel`);
do { await wait(500); job = await get(`/jobs/${jobId}`); } while (job.status === 'running');
await wait(1500);

const folder = join(job.folder, job.name.replace(/[\x00-\x1f/\\:*?"<>|%]/g, '_'));
const names = readdirSync(folder);
const mp3 = names.filter(n => n.endsWith('.mp3') && !n.includes('.tagged.'));
const leftovers = names.filter(n => !n.endsWith('.mp3') || n.includes('.tagged.'));
const missing = job.files.filter(f => !existsSync(f));
console.log(`status=${job.status}  finished tracks reported=${job.files.length}  mp3 on disk=${mp3.length}`);
console.log(`leftover temp files: ${leftovers.length ? leftovers.join(', ') : 'none'}`);
const ok = job.status === 'cancelled' && !leftovers.length && !missing.length && mp3.length >= job.files.length;
console.log(ok ? 'PASS  Stop keeps finished tracks and cleans up the rest.' : 'FAIL');
process.exit(ok ? 0 : 1);
