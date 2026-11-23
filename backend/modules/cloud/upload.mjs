// Upload jobs: songs from the library (by id) or from any folder (by path) -> the cloud's songs/ folder.
// One job at a time, songs one by one on the transfer connection (playing never waits behind an upload). Each song: skip it if the cloud already has it, check
// both budgets, upload as "<name>.part.mp3", rename when complete (so the other laptop never sees half a song),
// then add it to the shared index. Files listed in `removeAfter` ("Download to cloud") are deleted from this laptop
// once the cloud has them (uploaded, or already there); a file that failed stays.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileBase, sameIdentity } from '../../core/lib.mjs';
import { AUDIO_EXTS, forgetFile, getTrack, readTags } from '../../core/library.mjs';
import { LimitError } from './limits.mjs';
import { loadSettings } from './settings.mjs';
import { songPath, syncFolder, withCloud } from './store.mjs';

const jobs = new Map();
const controllers = new Map(); // job id -> AbortController (kept out of the job so it stays JSON-serialisable)

export const getUpload = id => jobs.get(id);
export const activeUpload = () => [...jobs.values()].find(j => j.state === 'running') ?? null;
export function cancelUpload(id) {
  controllers.get(id)?.abort();
}

const label = s => `${s.artist ? `${s.artist} - ` : ''}${s.title}`;
const item = (song, extra = {}) => ({ title: song.title, artist: song.artist || '', file: song.file || '', ...extra });

/** The cloud song this one duplicates: same ISRC, or same artist + title with a compatible length. */
const onCloud = (index, song) => index.songs.find(s => sameIdentity(s, song));

/** First free file name on the cloud: never overwrites a different song that shares the name. */
function freeFile(index, song) {
  const ext = extname(song.path).toLowerCase() || '.mp3';
  const base = fileBase(song.artist, song.title);
  const taken = new Set(index.songs.map(s => s.file.toLowerCase()));
  let name = `${base}${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
  return name;
}

async function songsFor({ trackIds = [], paths = [], removeAfter = [] }) {
  const removable = new Set(removeAfter);
  const songs = [];
  for (const id of trackIds) {
    const t = getTrack(Number(id));
    if (t && existsSync(t.path)) songs.push({ path: t.path, title: t.title, artist: t.artist, album: t.album, duration: t.duration, isrc: t.isrc, size: t.size });
  }
  for (const path of paths) {
    const tags = await readTags(path);
    songs.push({
      path, title: tags.title, artist: tags.artist, album: tags.album, duration: tags.duration, isrc: tags.isrc,
      size: tags.size, remove: removable.has(path),
    });
  }
  return songs;
}

/** Starts an upload in the background and returns its job (poll getUpload(job.id)). */
export function startUpload(selection, settings = loadSettings()) {
  if (activeUpload()) throw new Error('An upload is already running. Wait for it or press Stop.');
  const job = {
    id: randomUUID(), state: 'running', total: 0, done: 0, bytesDone: 0, bytesTotal: 0, current: 'Connecting...',
    uploaded: [], skipped: [], failed: [], removed: 0, error: null,
  };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  run(job, selection, settings, controller.signal)
    .catch(e => { job.state = 'failed'; job.error = e.message; })
    .finally(() => {
      job.current = null;
      controllers.delete(job.id);
      startWaiting();
    });
  return job;
}

const waiting = []; // { selection, settings } asked for while an upload was running

/** The uploads that waited, together as one job (songs already on the cloud are skipped as usual). */
function startWaiting() {
  if (!waiting.length || activeUpload()) return;
  const batch = waiting.splice(0);
  const selection = {
    trackIds: batch.flatMap(w => w.selection.trackIds ?? []),
    paths: batch.flatMap(w => w.selection.paths ?? []),
    removeAfter: batch.flatMap(w => w.selection.removeAfter ?? []),
  };
  try {
    startUpload(selection, batch.at(-1).settings);
  } catch (e) {
    console.error('Cloud upload:', e.message);
  }
}

/** Like startUpload, but when an upload is running this one waits and starts right after it. */
export function queueUpload(selection, settings = loadSettings()) {
  if (!activeUpload()) return { jobId: startUpload(selection, settings).id };
  waiting.push({ selection, settings });
  return { queued: true };
}

/** The cloud has this song now: delete the laptop copy if it was only downloaded to go there. */
async function dropLocal(song, job) {
  if (!song.remove) return;
  try {
    await rm(song.path, { force: true });
    forgetFile(song.path);
    job.removed++;
  } catch (e) {
    console.error(`Could not delete "${song.path}" after uploading it:`, e.message);
  }
}
/** Why a song failed, saying its file was kept when it was meant to leave the laptop. */
const failReason = (song, reason) => (song.remove ? `${reason} (kept on this laptop)` : reason);

async function run(job, selection, settings, signal) {
  const songs = await songsFor(selection);
  job.total = songs.length;
  job.bytesTotal = songs.reduce((sum, s) => sum + s.size, 0);
  await withCloud(async cloud => {
    await syncFolder(cloud); // files added by hand are in the index, so freeFile never picks their name
    const index = await cloud.index();
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      if (signal.aborted) break;
      job.current = label(song);
      const twin = onCloud(index, song);
      if (twin) {
        job.skipped.push(item(song, { reason: `Already on the cloud as "${label(twin)}"` }));
        await dropLocal(song, job);
        job.done++;
        continue;
      }
      try {
        await cloud.ensureRoom(song.size, { storage: true });
      } catch (e) {
        if (!(e instanceof LimitError)) throw e;
        // Every song left would hit the same wall: report them all and stop.
        for (const rest of songs.slice(i)) job.failed.push(item(rest, { reason: failReason(rest, e.message) }));
        job.done = job.total;
        break;
      }
      const file = freeFile(index, song);
      const ext = extname(file);
      const part = `songs/${file.slice(0, -ext.length)}.part${ext}`;
      const start = job.bytesDone;
      try {
        await cloud.session.upload(song.path, part, { signal, onBytes: n => { job.bytesDone = start + n; } });
        await cloud.session.rename(part, songPath({ file }));
        index.songs.push(await cloud.addSong({ ...song, file }));
        job.bytesDone = start + song.size;
        job.uploaded.push(item(song, { file }));
        await dropLocal(song, job);
      } catch (e) {
        if (signal.aborted) {
          await cloud.session.remove(part).catch(() => {}); // no half song left on the cloud
          job.bytesDone = start;
          break;
        }
        job.failed.push(item(song, { reason: failReason(song, e.message.replace(/^Cloud: /, '')) }));
      }
      job.done++;
    }
  }, settings, { lane: 'transfer' });
  job.state = signal.aborted ? 'stopped' : 'done';
}

/** Every audio file in a folder and its subfolders, with its tags. */
export async function scanFolder(folder) {
  if (!existsSync(folder)) throw new Error(`The folder "${folder}" does not exist.`);
  const songs = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (AUDIO_EXTS.has(extname(entry.name).toLowerCase()) && !/\.part\.\w+$/i.test(entry.name)) {
        const tags = await readTags(full);
        songs.push({ path: full, title: tags.title, artist: tags.artist, album: tags.album, duration: tags.duration, size: (await stat(full)).size });
      }
    }
  };
  await walk(folder);
  return songs.sort((a, b) => a.path.localeCompare(b.path));
}

/** Opens the Windows folder picker (on top of the browser). Resolves with the chosen folder, or null. */
export function pickFolder() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Choose a folder of songs to upload to the cloud"',
    'if ($dialog.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($dialog.SelectedPath) }',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim() || null));
  });
}
