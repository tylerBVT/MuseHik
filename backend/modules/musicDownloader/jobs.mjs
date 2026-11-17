// Download jobs: link -> background job -> audio files in ONE flat folder (config.json "musicDir"), indexed in SQLite.
// Flow (same idea as OpenCrate/spotDL): a platform service reads the track list, the library says which songs
// we already have, the engine finds the rest on YouTube with yt-dlp, downloads them as MP3 and tags them.
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { downloadAudio, findOnYoutube, outputDir, tagFile } from './engine.mjs';
import { fileBase, trackKey } from '../../core/lib.mjs';
import { addFile, findDuplicate } from '../../core/library.mjs';

const MAX_TRACKS = 200;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

const jobs = new Map();
const controllers = new Map(); // jobId -> AbortController (kept out of the job so the job stays JSON-serialisable)

const youtubeSource = url => `youtube:${new URL(url).searchParams.get('v')}`;

/** First free "<base>.mp3" name: never overwrites a different song that happens to share the name. */
function freeBase(base) {
  let candidate = base;
  for (let n = 2; existsSync(join(outputDir, `${candidate}.mp3`)); n++) candidate = `${base} (${n})`;
  return candidate;
}

/**
 * Downloads one track into the flat folder.
 * Returns { file } when downloaded, { skipped: reason } when the song is already there.
 * `claimed` holds keys being downloaded by this job, so a song listed twice is fetched once.
 */
async function downloadTrack(track, claimed, signal, onBase) {
  const direct = Boolean(track.sourceUrl); // YouTube link: no search, keep yt-dlp's own tags
  const key = track.title ? trackKey(track.artist, track.title) : null;
  const dup = findDuplicate({ ...track, source: direct ? youtubeSource(track.sourceUrl) : undefined });
  if (dup) return { skipped: `Already in your library as "${dup.artist ? `${dup.artist} - ` : ''}${dup.title}"` };
  if (key) {
    if (claimed.has(key)) return { skipped: 'Listed twice in this playlist' };
    claimed.add(key);
  }

  let source = track.sourceUrl;
  if (!direct) {
    source = await findOnYoutube(track, signal);
    const same = findDuplicate({ source: youtubeSource(source) });
    if (same) return { skipped: `Already in your library as "${same.artist ? `${same.artist} - ` : ''}${same.title}"` };
  }

  const base = track.title ? freeBase(fileBase(direct ? '' : track.artist, track.title)) : null;
  onBase(base);
  const template = base ? `${base}.%(ext)s` : '%(artist,uploader)s - %(title)s.%(ext)s';
  const file = await downloadAudio(source, join(outputDir, template), signal);
  if (!direct) await tagFile(file, track, signal);
  await addFile(file, youtubeSource(source));
  return { file };
}

/** After Stop or a failure: remove leftovers (thumbnails, partial files) of one unfinished track. */
async function cleanupUnfinished(bases, settleMs = 700) {
  const prefixes = bases.filter(Boolean).map(b => `${b}.`);
  if (!prefixes.length) return;
  await new Promise(r => setTimeout(r, settleMs)); // let killed child processes release their files
  for (const name of await readdir(outputDir)) {
    if (prefixes.some(p => name.startsWith(p))) await rm(join(outputDir, name), { force: true }).catch(() => {});
  }
}

async function processJob(job, { service, ref }, signal) {
  try {
    job.current = `Reading ${service.label} link...`;
    const collection = await service.resolve(ref);
    const tracks = collection.tracks.slice(0, MAX_TRACKS);
    job.name = collection.name;
    job.total = tracks.length;
    if (collection.tracks.length > MAX_TRACKS) job.warning = `Only the first ${MAX_TRACKS} tracks are downloaded.`;
    await mkdir(outputDir, { recursive: true });

    // Each finished file stays on disk (and in the index) immediately, so stopping keeps all progress.
    const queue = [...tracks];
    const claimed = new Set();
    const inFlight = new Map(); // track -> file base name (for cleanup)
    const worker = async () => {
      for (let track; !signal.aborted && (track = queue.shift());) {
        const label = track.sourceUrl && !track.title ? track.sourceUrl : `${track.artist} - ${track.title}`;
        job.current = label;
        inFlight.set(track, null);
        try {
          const result = await downloadTrack(track, claimed, signal, base => inFlight.set(track, base));
          inFlight.delete(track);
          if (result.file) job.files.push(result.file);
          else { job.skippedList.push({ track: label, reason: result.skipped }); job.skipped++; }
          job.done++;
        } catch (e) {
          if (signal.aborted) return;
          await cleanupUnfinished([inFlight.get(track)], 0);
          inFlight.delete(track);
          job.failed.push({ track: label, error: e.message });
          job.done++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));

    if (signal.aborted) {
      await cleanupUnfinished([...inFlight.values()]);
      job.status = 'cancelled';
    } else {
      const ok = job.files.length + job.skipped > 0;
      job.status = ok ? 'done' : 'error';
      if (!ok) job.error = job.failed[0]?.error || 'Nothing was downloaded.';
    }
  } catch (e) {
    job.status = signal.aborted ? 'cancelled' : 'error';
    if (!signal.aborted) job.error = e.message;
  }
  job.current = '';
  controllers.delete(job.id);
}

export function startJob(detected) {
  const job = {
    id: randomUUID(), platform: detected.service.id, status: 'running', name: '', total: 0, done: 0, skipped: 0,
    current: '', files: [], skippedList: [], failed: [], folder: outputDir,
  };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  void processJob(job, detected, controller.signal);
  return job;
}

export const getJob = id => jobs.get(id);
export const cancelJob = id => controllers.get(id)?.abort();
