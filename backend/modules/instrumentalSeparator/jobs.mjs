// Separation jobs: a library song + a method -> instrumental MP3, made by separate.py (Python, PyTorch, the GPU).
// One job runs at a time (one GPU); others wait in the queue. Results live outside OneDrive:
//   <heavyDir>/instrumentals/<song file name> [<method>].mp3
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpeg, heavyDir, separatorModelsDir, separatorPython } from '../../core/config.mjs';
import { getTrack } from '../../core/library.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const resultsDir = join(heavyDir, 'instrumentals');
export const methods = JSON.parse(readFileSync(join(moduleDir, 'methods.json'), 'utf8'));
const methodIds = new Set(methods.map(m => m.id));
const TITLE_SUFFIX = { backing: ' (Instrumental + backing vocals)' };

const jobs = new Map();      // id -> job (plain JSON, sent to the page)
const processes = new Map(); // id -> child process
const queue = [];            // ids waiting
let running = null;          // id running

const songBase = track => basename(track.path, extname(track.path));
export const resultPath = (track, method) => join(resultsDir, `${songBase(track)} [${method}].mp3`);

/** Kills a process and its children (plain kill() can leave children running on Windows). */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill();
}

/** Is the separator installed (its Python venv)? */
export const available = () => existsSync(separatorPython);

/** Finished instrumentals of one song, one per method. */
export async function resultsFor(track) {
  const out = [];
  for (const method of methods) {
    const path = resultPath(track, method.id);
    if (!existsSync(path)) continue;
    const info = await stat(path);
    out.push({ method: method.id, size: info.size, createdAt: info.mtime.toISOString() });
  }
  return out;
}

export async function deleteResult(track, method) {
  const path = resultPath(track, method);
  if (!existsSync(path)) return false;
  await rm(path, { force: true });
  return true;
}

export const getJob = id => jobs.get(id);
/** The queued or running job of a song, if any (so the page can pick it up again after a reload). */
export const activeJobFor = trackId =>
  [...jobs.values()].find(j => j.trackId === trackId && (j.status === 'queued' || j.status === 'running')) ?? null;

export function startJob(trackId, method) {
  if (!methodIds.has(method)) throw new Error(`Unknown method "${method}".`);
  const track = getTrack(trackId);
  if (!track || !existsSync(track.path)) throw new Error('Song not found in the library.');
  if (!available()) throw new Error(`The separator is not installed (no Python at ${separatorPython}). See backend/modules/instrumentalSeparator/README.md.`);
  const same = [...jobs.values()].find(j => j.trackId === trackId && j.method === method && (j.status === 'queued' || j.status === 'running'));
  if (same) return same;

  const job = {
    id: randomUUID(), trackId, method, title: track.title, artist: track.artist,
    status: 'queued', stage: 'Waiting for the GPU', progress: 0, error: null,
    createdAt: new Date().toISOString(), seconds: null,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void next();
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return job ?? null;
  job.status = 'cancelled';
  job.stage = 'Stopped';
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
  const child = processes.get(id);
  if (child) killTree(child);
  return job;
}

async function next() {
  if (running || queue.length === 0) return;
  const id = queue.shift();
  const job = jobs.get(id);
  running = id;
  try {
    await run(job);
  } finally {
    running = null;
    processes.delete(id);
    void next();
  }
}

async function run(job) {
  const track = getTrack(job.trackId);
  const output = resultPath(track, job.method);
  await mkdir(resultsDir, { recursive: true });
  job.status = 'running';
  job.stage = 'Starting';
  const started = Date.now();
  const args = [
    '-W', 'ignore', join(moduleDir, 'separate.py'), track.path, output, '--method', job.method,
    '--models-dir', separatorModelsDir, '--ffmpeg', ffmpeg, '--title', `${track.title}${TITLE_SUFFIX[job.method] ?? ' (Instrumental)'}`,
  ];
  const child = spawn(separatorPython, args, { cwd: moduleDir, shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  processes.set(job.id, child);

  let stderr = '';
  let buffer = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', d => {
    buffer += d;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'progress' && job.status === 'running') {
          job.stage = event.stage;
          job.progress = event.progress;
        } else if (event.event === 'error') job.error = event.message;
      } catch { /* not one of our lines */ }
    }
  });

  const code = await new Promise(resolve => {
    child.on('error', error => { job.error = error.message; resolve(-1); });
    child.on('close', resolve);
  });
  job.seconds = Math.round((Date.now() - started) / 100) / 10;
  if (job.status === 'cancelled') {
    await removePartials(output);
    return;
  }
  if (code === 0 && existsSync(output)) {
    job.status = 'done';
    job.stage = 'Done';
    job.progress = 1;
  } else {
    job.status = 'failed';
    job.stage = 'Failed';
    job.error = job.error || stderr.trim().split('\n').slice(-3).join(' ') || `separate.py exited with code ${code}`;
    await removePartials(output);
  }
}

async function removePartials(output) {
  await new Promise(r => setTimeout(r, 500)); // let the killed process release its files
  const prefix = basename(output);
  for (const name of await readdir(resultsDir).catch(() => [])) {
    if (name.startsWith(`${prefix}.part`)) await rm(join(resultsDir, name), { force: true }).catch(() => {});
  }
}
