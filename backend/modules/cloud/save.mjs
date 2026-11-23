// "Download from cloud": copies cloud songs into this laptop's music folder and library, one by one on the transfer
// connection. A song already cached on this laptop is copied from the cache (no download). The file gets the shared
// list's title, artist and genre as tags (a song added by hand, or renamed in the app, may have other tags), and is
// written as "<name>.part.mp3" first, so the library never sees half a song.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { outputDir } from '../../core/config.mjs';
import { fileBase } from '../../core/lib.mjs';
import { addFile, findDuplicate, freePath } from '../../core/library.mjs';
import { writeTags } from '../../core/tags.mjs';
import { localSource } from './cache.mjs';
import { isOnline, loadSettings } from './settings.mjs';
import { lastIndex, songPath, syncFolder, withCloud } from './store.mjs';

const jobs = new Map();
const controllers = new Map(); // job id -> AbortController (kept out of the job so it stays JSON-serialisable)

export const getSave = id => jobs.get(id);
export const activeSave = () => [...jobs.values()].find(j => j.state === 'running') ?? null;
export const cancelSave = id => controllers.get(id)?.abort();

const label = s => `${s.artist ? `${s.artist} - ` : ''}${s.title}`;
const item = (song, extra = {}) => ({ id: song.id, title: song.title, artist: song.artist || '', ...extra });

/** Starts saving these cloud songs (ids) in the background; returns the job (poll getSave(job.id)). */
export function startSave(ids, settings = loadSettings()) {
  if (activeSave()) throw new Error('Songs are already being saved to this laptop. Wait for it or press Stop.');
  const job = { id: randomUUID(), state: 'running', total: 0, done: 0, current: 'Reading the cloud list...', saved: [], skipped: [], failed: [], error: null };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
  run(job, ids.map(Number), settings, controller.signal)
    .catch(e => { job.state = 'failed'; job.error = e.message.replace(/^Cloud: /, ''); })
    .finally(() => { job.current = null; controllers.delete(job.id); });
  return job;
}

/** The cloud list: fresh when online, else the last one seen (cached songs can still be saved offline). */
async function cloudList(settings) {
  if (!isOnline(settings)) return lastIndex()?.songs ?? [];
  try {
    return await withCloud(async cloud => { await syncFolder(cloud); return (await cloud.index()).songs; }, settings);
  } catch {
    return lastIndex()?.songs ?? [];
  }
}

async function run(job, ids, settings, signal) {
  const list = await cloudList(settings);
  const songs = ids.map(id => list.find(s => s.id === id)).filter(Boolean);
  job.total = songs.length;
  mkdirSync(outputDir, { recursive: true });
  for (const song of songs) {
    if (signal.aborted) break;
    job.current = label(song);
    if (findDuplicate({ title: song.title, artist: song.artist, duration: song.duration, isrc: song.isrc })) {
      job.skipped.push(item(song, { reason: 'Already in your library' }));
      job.done++;
      continue;
    }
    const ext = extname(song.file).toLowerCase() || '.mp3';
    const target = freePath(outputDir, fileBase(song.artist, song.title), ext);
    const part = `${target.slice(0, -ext.length)}.part${ext}`;
    try {
      const cached = localSource(song);
      if (cached?.from === 'cache') await copyFile(cached.path, part);
      else await withCloud(cloud => cloud.session.download(songPath(song), part, { signal }), settings, { lane: 'transfer' });
      if (signal.aborted) throw new Error('Cloud: stopped.');
      let tagged = true;
      try {
        await writeTags(part, {
          title: song.title, artist: song.artist || undefined, album: song.album || undefined, genre: song.genre || undefined,
        });
      } catch (e) {
        tagged = false; // the song is still fine; only its tags are not the list's
        console.error(`Could not write the tags of "${song.file}":`, e.message);
      }
      await rename(part, target);
      await addFile(target);
      job.saved.push(item(song, { file: basename(target), tagged }));
    } catch (e) {
      await rm(part, { force: true });
      if (signal.aborted) break;
      job.failed.push(item(song, { reason: e.message.replace(/^Cloud: /, '') }));
    }
    job.done++;
  }
  job.state = signal.aborted ? 'stopped' : 'done';
}
