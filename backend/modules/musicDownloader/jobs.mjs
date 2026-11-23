// Download jobs: link -> background job -> audio files in ONE flat folder (config.json "musicDir"), indexed in SQLite.
// Flow (same idea as OpenCrate/spotDL): a platform service reads the track list, the library says which songs
// we already have, the engine finds the rest on YouTube with yt-dlp, downloads them as MP3 and tags them.
// When things go wrong:
//   - an upload that cannot be had (removed, DRM, region...): the next plausible upload from the search is tried
//   - "yt-dlp is probably outdated": yt-dlp is updated once (see updater.mjs) and the track retried
//   - YouTube says "not a bot?": the job pauses (asking again would make the block longer) and resumes by itself
//     when the wait is over (10, 20, 40, 60 min...). After MAX_BLOCKS blocks in a row with no success in between it
//     gives up; the tracks not tried yet are listed, and "Try again" later picks them up (finished ones are
//     skipped as duplicates). That is also how a very long playlist continues after the PC was turned off.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { dataDir } from '../../core/config.mjs';
import {
  clock, downloadAudio, findOnYoutube, outputDir, sleep, tagFile, youtubeBlockStreak, youtubeBlockedUntil,
} from './engine.mjs';
import { explain } from './errors.mjs';
import { detect } from './services/index.mjs';
import { saveReport } from './report.mjs';
import { updateAfterFailure, versions } from './updater.mjs';
import { fileBase, sameIdentity, trackKey } from '../../core/lib.mjs';
import { addFile, db, duplicateOfFile, findDuplicate } from '../../core/library.mjs';
import { lastIndex, syncFolder, withCloud } from '../cloud/store.mjs';
import { queueUpload } from '../cloud/upload.mjs';

const MAX_TRACKS = 10000; // a safety net only: Deezer playlists hold at most 10,000 songs
const MAX_BLOCKS = 5; // YouTube blocks in a row (about 3 hours of waiting) before a job gives up
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const HISTORY_KEEP = 100;

const jobs = new Map();
const controllers = new Map(); // jobId -> AbortController (kept out of the job so the job stays JSON-serialisable)

// Every finished download (success or not) is kept, so its result and errors can be read again later.
db.exec(`CREATE TABLE IF NOT EXISTS download_history (
  id TEXT PRIMARY KEY, finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, job TEXT NOT NULL)`);
const hq = {
  insert: db.prepare('INSERT OR REPLACE INTO download_history (id, job) VALUES (?, ?)'),
  list: db.prepare('SELECT job FROM download_history ORDER BY finished_at DESC, rowid DESC LIMIT ?'),
  prune: db.prepare(`DELETE FROM download_history WHERE id NOT IN
    (SELECT id FROM download_history ORDER BY finished_at DESC, rowid DESC LIMIT ?)`),
  remove: db.prepare('DELETE FROM download_history WHERE id = ?'),
  clear: db.prepare('DELETE FROM download_history'),
};

/** Past downloads, newest first. */
export const listHistory = () => hq.list.all(HISTORY_KEEP).map(row => JSON.parse(row.job));
export const deleteHistory = id => (id ? hq.remove.run(id) : hq.clear.run()).changes;

const youtubeSource = url => `youtube:${new URL(url).searchParams.get('v')}`;
const describe = row => `"${row.artist ? `${row.artist} - ` : ''}${row.title}"`;
const alreadyHave = row => `Already in your library as ${describe(row)} (${row.matchedBy})`;

// What the download reports keep about songs, uploads and library matches (see report.mjs).
const songInfo = t => ({
  number: t.number, artist: t.artist || '', title: t.title || '', album: t.album || '',
  duration: t.duration || 0, isrc: t.isrc || '', url: t.sourceUrl || '',
});
const uploadInfo = c => ({ url: c.url, title: c.title || '', channel: c.artist || '', duration: c.duration || 0 });
const matchInfo = row => ({
  id: row.id, artist: row.artist, title: row.title, duration: row.duration, file: basename(row.path), matchedBy: row.matchedBy,
});

/** First free "<base>.mp3" name: never overwrites a different song that happens to share the name. */
function freeBase(base) {
  let candidate = base;
  for (let n = 2; existsSync(join(outputDir, `${candidate}.mp3`)); n++) candidate = `${base} (${n})`;
  return candidate;
}

/**
 * Downloads one URL; when the failure looks like "yt-dlp is outdated", updates yt-dlp (once per job, shared by
 * all workers) and tries again.
 */
async function fetchAudio(url, template, ctx) {
  try {
    return await downloadAudio(url, template, ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted || explain(e).kind !== 'outdated') throw e;
    ctx.job.current = 'Updating yt-dlp (YouTube changed something)...';
    ctx.update ??= updateAfterFailure().then(result => {
      if (result.changed) ctx.job.notes.push(`yt-dlp was updated from ${result.before} to ${result.after} during this download.`);
      return result;
    });
    if (!(await ctx.update).changed) throw e;
    return downloadAudio(url, template, ctx.signal);
  }
}

/**
 * Downloads one track into the flat folder.
 * Returns { file, used } when downloaded, { skipped: reason, match } when the song is already there.
 * `ctx.claimed` holds keys being downloaded by this job, so a song listed twice is fetched once.
 * `rec` collects what happened (step reached, uploads found and tried) for the download report.
 */
async function downloadTrack(track, label, ctx, onBase, rec) {
  // "Download to cloud": a song the cloud already has is not downloaded at all.
  const twin = ctx.cloudSongs && track.title && ctx.cloudSongs.find(s => sameIdentity(s, track));
  if (twin) return { skipped: `Already on the cloud as "${twin.artist ? `${twin.artist} - ` : ''}${twin.title}"`, onCloud: true };
  rec.stage = 'library check';
  const direct = Boolean(track.sourceUrl); // YouTube link: no search, keep yt-dlp's own tags
  const key = track.title ? trackKey(track.artist, track.title) : null;
  const dup = findDuplicate({ ...track, source: direct ? youtubeSource(track.sourceUrl) : undefined });
  if (dup) return { skipped: alreadyHave(dup), match: matchInfo(dup) };
  if (key) {
    if (ctx.claimed.has(key)) return { skipped: 'Listed twice in this playlist' };
    ctx.claimed.add(key);
  }

  let candidates = [{ url: track.sourceUrl }];
  if (!direct) {
    rec.stage = 'YouTube search';
    candidates = await findOnYoutube(track, ctx.signal);
    rec.candidates = candidates.map(uploadInfo);
    for (const c of candidates) {
      const same = findDuplicate({ source: youtubeSource(c.url) }) || findDuplicate(c);
      if (same) {
        return { skipped: `${alreadyHave(same)}, found through the upload "${c.title}"`, match: { ...matchInfo(same), via: uploadInfo(c) } };
      }
    }
  } else {
    rec.candidates = [{ url: track.sourceUrl, title: '', channel: '', duration: 0 }];
  }

  // A direct link's file name is only known after the download, and could equal an existing song's name. So it is
  // downloaded into a private folder first, checked there, and only then moved in under a free name: a download
  // can never touch a file that is already in the library.
  const incoming = direct ? join(dataDir, 'incoming', randomUUID()) : null;
  const base = track.title ? freeBase(fileBase(direct ? '' : track.artist, track.title)) : null;
  onBase(base);
  const template = incoming
    ? join(incoming, '%(artist,uploader)s - %(title)s.%(ext)s')
    : join(outputDir, `${base}.%(ext)s`);
  try {
    return await downloadCandidates(track, label, ctx, { candidates, direct, base, template, rec });
  } finally {
    if (incoming) await rm(incoming, { recursive: true, force: true }).catch(() => {});
  }
}

/** Moves a checked file from the private download folder into the library folder under a free name. */
async function moveIn(file) {
  const name = basename(file, extname(file));
  const target = join(outputDir, `${freeBase(name)}${extname(file)}`);
  try {
    await rename(file, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // different drive: copy instead
    await copyFile(file, target);
    await rm(file, { force: true });
  }
  return target;
}

/** Tries the candidate uploads in order until one downloads (see downloadTrack). */
async function downloadCandidates(track, label, ctx, { candidates, direct, base, template, rec }) {
  let firstError;
  for (const [i, candidate] of candidates.entries()) {
    let file;
    rec.stage = `download (upload ${i + 1} of ${candidates.length})`;
    try {
      file = await fetchAudio(candidate.url, template, ctx);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      firstError ??= e;
      const why = explain(e);
      rec.attempts.push({ url: candidate.url, kind: why.kind, error: String(e.message || '').slice(0, 300) });
      // Only an upload-specific problem is worth another upload; a block or a network error is not.
      if (!['unavailable', 'outdated'].includes(why.kind)) throw e;
      await cleanupUnfinished([base], 0);
      continue;
    }
    if (direct) {
      // A direct link has no title beforehand: compare the file's own tags with the library now (the file is
      // still in the private folder, which downloadTrack deletes afterwards).
      rec.stage = 'library check after download';
      const same = await duplicateOfFile(file);
      if (same) return { skipped: alreadyHave(same), match: matchInfo(same) };
      file = await moveIn(file);
    } else {
      rec.stage = 'tagging';
      await tagFile(file, track, ctx.signal);
    }
    rec.stage = 'adding to library';
    await addFile(file, youtubeSource(candidate.url));
    if (i > 0) {
      ctx.job.notes.push(`${label}: the best YouTube match could not be downloaded (${explain(firstError).error}) `
        + `so upload #${i + 1} "${candidate.title}" by ${candidate.artist} was used.`);
    }
    return { file, used: { ...uploadInfo(candidate), rank: i + 1 } };
  }
  throw firstError;
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

const labelOf = track => (track.sourceUrl && !track.title ? track.sourceUrl : `${track.artist} - ${track.title}`);

async function processJob(job, signal) {
  let blocked = null;
  try {
    const { service, ref } = detect(job.url);
    job.platform = service.id;
    job.current = `Reading ${service.label} link...`;
    const collection = await service.resolve(ref);
    const tracks = collection.tracks.slice(0, MAX_TRACKS);
    job.name = collection.name;
    job.total = tracks.length;
    if (collection.tracks.length > MAX_TRACKS) job.warning = `Only the first ${MAX_TRACKS} tracks are downloaded.`;
    if (tracks.length > 300) {
      job.notes.push(`Long playlist (${tracks.length} songs): MuseHik spaces out its YouTube requests so YouTube does `
        + 'not block it, so this takes hours. You can keep using the app; if it is interrupted, paste the same link '
        + 'again: songs already downloaded are skipped in seconds.');
    }
    await mkdir(outputDir, { recursive: true });

    // Each finished file stays on disk (and in the index) immediately, so stopping keeps all progress.
    const queue = [...tracks];
    const inFlight = new Map(); // track -> file base name (for cleanup)
    // Shared by all workers: `update` is the one yt-dlp update this job may run (see fetchAudio).
    const ctx = { job, signal, claimed: new Set(), update: null, cloudSongs: job.cloudOnly ? await cloudSongs() : null };
    const pauses = new Set(); // distinct YouTube blocks this job waited out
    const worker = async () => {
      for (let track; !signal.aborted && !blocked && (track = queue.shift());) {
        const label = labelOf(track);
        job.current = label;
        inFlight.set(track, null);
        const rec = { stage: 'starting', candidates: [], attempts: [] };
        try {
          const result = await downloadTrack(track, label, ctx, base => inFlight.set(track, base), rec);
          inFlight.delete(track);
          if (result.file) {
            job.files.push(result.file);
            job.downloaded.push({ track: label, song: songInfo(track), file: basename(result.file), used: result.used });
          } else {
            job.skippedList.push({
              track: label, reason: result.skipped, song: songInfo(track), match: result.match, onCloud: result.onCloud,
            });
            job.skipped++;
          }
          job.done++;
        } catch (e) {
          if (signal.aborted) return;
          await cleanupUnfinished([inFlight.get(track)], 0);
          inFlight.delete(track);
          const why = explain(e);
          if (why.kind === 'blocked') {
            queue.unshift(track); // not this track's fault: it goes back in line
            const until = youtubeBlockedUntil();
            if (blocked || !until || youtubeBlockStreak() > MAX_BLOCKS) {
              blocked ??= why; // give up: the rest is listed as "not tried"
              return;
            }
            // Pause every worker until YouTube should be OK again, then carry on.
            if (!pauses.has(until)) {
              pauses.add(until);
              job.pauses = (job.pauses || 0) + 1;
              job.pausedMinutes = (job.pausedMinutes || 0) + Math.round((until - Date.now()) / 60000);
            }
            job.pausedUntil = new Date(until).toISOString();
            job.current = `Paused: YouTube is blocking this computer. Resuming by itself at ${clock(until)}...`;
            try {
              await sleep(until - Date.now() + 2000, signal);
            } catch {
              return; // Stop was pressed while waiting
            }
            job.pausedUntil = null;
            continue;
          }
          job.failed.push({
            track: label, ...why, song: songInfo(track), stage: rec.stage, candidates: rec.candidates,
            attempts: rec.attempts, at: new Date().toISOString(),
          });
          job.done++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));

    if (job.pauses) {
      job.notes.push(`Paused ${job.pauses} time(s) because YouTube was blocking this computer `
        + `(about ${job.pausedMinutes} min of waiting in total).`);
    }
    job.pausedUntil = null;
    if (queue.length || inFlight.size) job.notTried = [...inFlight.keys(), ...queue].map(labelOf);
    if (signal.aborted) {
      await cleanupUnfinished([...inFlight.values()]);
      job.status = 'cancelled';
    } else {
      const ok = job.files.length + job.skipped > 0;
      job.status = ok ? 'done' : 'error';
      if (blocked) Object.assign(job, { error: blocked.error, hint: blocked.hint, detail: blocked.detail });
      else if (!ok) {
        const { error = 'Nothing was downloaded.', hint = '' } = job.failed[0] || {};
        Object.assign(job, { error, hint });
      }
    }
  } catch (e) {
    job.status = signal.aborted ? 'cancelled' : 'error';
    if (!signal.aborted) Object.assign(job, explain(e));
  }
  job.current = '';
  if (job.cloudOnly) sendToCloud(job);
  job.finishedAt = new Date().toISOString();
  job.ytdlp = (await versions().catch(() => null))?.ytdlp ?? null;
  try {
    job.reportFile = await saveReport(job);
  } catch (e) {
    console.error('Could not save the download report:', e.message);
  }
  controllers.delete(job.id);
  try {
    hq.insert.run(job.id, JSON.stringify(job));
    hq.prune.run(HISTORY_KEEP);
  } catch (e) {
    console.error('Could not save download history:', e.message);
  }
}

/** The cloud's songs, read when a "Download to cloud" starts (the last list seen if the cloud does not answer). */
async function cloudSongs() {
  try {
    return await withCloud(async cloud => { await syncFolder(cloud); return (await cloud.index()).songs; });
  } catch {
    return lastIndex()?.songs ?? [];
  }
}

/**
 * What "Download to cloud" uploads: the songs this download got (deleted from the laptop once on the cloud), plus the
 * ones it skipped because the library already had them (sent from the library and kept there). The upload itself
 * skips songs the cloud already has.
 */
export const cloudSelection = job => ({
  paths: [...job.files],
  trackIds: job.skippedList.map(s => s.match?.id).filter(Number.isInteger),
  removeAfter: [...job.files],
});

/** At the end of a download (finished or stopped): hands its songs to the cloud upload (it waits if one is running). */
function sendToCloud(job) {
  const selection = cloudSelection(job);
  const songs = selection.paths.length + selection.trackIds.length;
  if (!songs) return;
  try {
    job.cloud = { songs, ...queueUpload(selection) };
  } catch (e) {
    job.cloud = { songs, error: e.message };
  }
}

/** Starts a download. `cloudOnly` ("Download to cloud"): its songs go to the cloud and leave this laptop. */
export function startJob(url, { cloudOnly = false } = {}) {
  const job = {
    id: randomUUID(), url: String(url ?? '').trim(), platform: '', status: 'running', name: '', total: 0, done: 0,
    cloudOnly: Boolean(cloudOnly),
    skipped: 0, current: 'Reading link...', files: [], downloaded: [], skippedList: [], failed: [], notes: [], folder: outputDir,
    startedAt: new Date().toISOString(),
  };
  const controller = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, controller);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  void processJob(job, controller.signal);
  return job;
}

export const getJob = id => jobs.get(id);
/** The download running right now, if any (the page picks it up again after a reload). */
export const activeJob = () => [...jobs.values()].reverse().find(j => j.status === 'running') ?? null;
export const cancelJob = id => controllers.get(id)?.abort();
