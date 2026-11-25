// Upload jobs: songs from the library (by id) or from any folder (by path) -> the cloud's songs/ folder.
// One job at a time, songs one by one through the music API. Each song: skip it if the cloud already has it, else
// upload it with its details (the server names it, refuses duplicates and checks the storage cap). Files listed in `removeAfter` ("Download to cloud") are deleted from this laptop
// once the cloud has them (uploaded, or already there); a file that failed stays.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { extname, join } from 'node:path';
import { sameIdentity } from '../../core/lib.mjs';
import { AUDIO_EXTS, forgetFile, getTrack, readTags } from '../../core/library.mjs';
import { loadSettings } from './settings.mjs';
import { withCloud } from './store.mjs';

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
    const index = await cloud.index(); // the server lists songs added by hand first
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
      const start = job.bytesDone;
      let sent = 0;
      try {
        // The server picks a free "Artist - Title" name, refuses duplicates and checks the storage cap under its lock
        // (the other laptop may upload at the same time), and keeps nothing of an upload that stops halfway.
        const saved = await cloud.upload(song.path, {
          title: song.title, artist: song.artist, album: song.album, duration: song.duration, isrc: song.isrc,
          addedBy: hostname(),
        }, { signal, onBytes: n => { sent = n; job.bytesDone = start + n; } });
        index.songs.push(saved);
        job.bytesDone = start + song.size;
        job.uploaded.push(item(song, { file: saved.file }));
        await dropLocal(song, job);
      } catch (e) {
        if (signal.aborted) {
          // Stopped just after the last byte: the server may have kept the song. Report what really happened.
          const kept = sent >= song.size
            && (await cloud.index().catch(() => ({ songs: [] }))).songs.find(s => sameIdentity(s, song));
          if (kept) job.uploaded.push(item(song, { file: kept.file }));
          else job.bytesDone = start;
          break;
        }
        job.bytesDone = start;
        if (e.status === 409 && e.song) {
          job.skipped.push(item(song, { reason: `Already on the cloud as "${label(e.song)}"` }));
          await dropLocal(song, job);
        } else if (e.status === 413 && /Not enough cloud storage/.test(e.message)) {
          // Every song left would hit the same wall: report them all and stop.
          const reason = e.message.replace(/^Cloud: /, '');
          for (const rest of songs.slice(i)) job.failed.push(item(rest, { reason: failReason(rest, reason) }));
          job.done = job.total;
          break;
        } else {
          job.failed.push(item(song, { reason: failReason(song, e.message.replace(/^Cloud: /, '')) }));
        }
      }
      job.done++;
    }
  }, settings);
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
