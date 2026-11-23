// Download engine: finds audio on YouTube (yt-dlp) and writes tagged MP3 files (ffmpeg).
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankMatches } from '../../core/lib.mjs';
import { ffmpeg, musicDir, python } from '../../core/config.mjs';
import { explain, explainedError } from './errors.mjs';

export { musicDir, python };

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, 'ytdlp_launcher.py'); // yt-dlp + DNS fallback (see file header)

/** Kills a process and its children (yt-dlp starts ffmpeg; plain kill() would leave it running on Windows). */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill();
}

/** Runs a program. An AbortSignal kills it (used by the Stop button). */
function run(command, args, { timeout = 600000, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    // UTF-8 everywhere: otherwise Python prints file paths in the Windows code page and "Décembre.mp3" comes back
    // as "D?cembre.mp3", a file that does not exist (the download worked but was reported as failed).
    const child = spawn(command, args, { shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '', err = '';
    const onAbort = () => { killTree(child); reject(new Error('Stopped.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { killTree(child); reject(new Error('Timed out.')); }, timeout);
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stdout.on('data', b => (out += b));
    child.stderr.on('data', b => (err = (err + b).slice(-4000)));
    child.on('error', e => { done(); reject(new Error(e.message)); });
    child.on('close', code => {
      done();
      if (code === 0) return resolvePromise(out);
      // The message is yt-dlp's last ERROR line; the full stderr tail stays available as `detail`.
      const lines = err.trim().split(/\r?\n/);
      const error = new Error([...lines].reverse().find(l => l.startsWith('ERROR:')) || lines.pop() || `exit code ${code}`);
      error.detail = err.trim();
      reject(error);
    });
  });
}
export { run };

/** Resolves after `ms`, or rejects with "Stopped." when the signal aborts first. */
function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    const onAbort = () => { clearTimeout(timer); reject(new Error('Stopped.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- Being gentle with YouTube: too many requests in a row is what gets a computer flagged as a bot.
// Every yt-dlp start (search, playlist read, download) waits for its slot: at least GAP_MS (+ a little random)
// after the previous one, shared by all running downloads.
const GAP_MS = Number(process.env.YOUTUBE_GAP_MS ?? 2500);
let nextSlot = 0;
async function waitForSlot(signal) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + GAP_MS + Math.floor(Math.random() * GAP_MS * 0.6);
  if (slot > now) await sleep(slot - now, signal);
}

// After YouTube says "not a bot?", every further request only makes it worse: stop asking for a while.
// Each block in a row doubles the wait (10, 20, 40, then 60 minutes max); one successful request resets it.
const COOLDOWN_MS = Number(process.env.YOUTUBE_COOLDOWN_MS ?? 10 * 60 * 1000);
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
let blockedUntil = 0;
let blockStreak = 0;
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function checkCooldown() {
  if (Date.now() >= blockedUntil) return;
  throw explainedError({
    kind: 'blocked',
    error: `YouTube blocked this computer a few minutes ago, so MuseHik is not asking it anything until ${clock(blockedUntil)} (asking again would extend the block).`,
    hint: `Try again after ${clock(blockedUntil)}.`,
    detail: '',
  });
}

// ---- Updates: while yt-dlp is being updated, no new yt-dlp process may start (and the update waits for
// the running ones to finish).
let active = 0;
let updateGate = null;
/** Runs fn() with no yt-dlp process running and none starting until it is done. */
export async function whileIdle(fn) {
  while (updateGate) await updateGate;
  let open;
  updateGate = new Promise(r => (open = r));
  try {
    while (active > 0) await sleep(300);
    return await fn();
  } finally {
    updateGate = null;
    open();
  }
}

// YouTube asks unknown computers to "sign in to confirm you're not a bot". The embedded-player client
// (what other websites use to show a YouTube video) is usually spared that check, so yt-dlp also tries it.
const YOUTUBE_CLIENTS = 'youtube:player_client=default,web_embedded';
export const ytdlpArgs = args => [launcher, '--ignore-config', '--js-runtimes', 'node',
  '--extractor-args', YOUTUBE_CLIENTS, '--ffmpeg-location', ffmpeg, ...args];

async function ytdlp(args, options = {}) {
  while (updateGate) await updateGate;
  checkCooldown();
  await waitForSlot(options.signal);
  while (updateGate) await updateGate; // an update may have started while waiting for the slot
  checkCooldown();
  active++;
  try {
    const out = await run(python, ytdlpArgs(args), options);
    blockStreak = 0;
    return out;
  } catch (e) {
    if (explain(e).kind === 'blocked') {
      blockStreak++;
      blockedUntil = Date.now() + Math.min(COOLDOWN_MS * 2 ** (blockStreak - 1), MAX_COOLDOWN_MS);
    }
    throw e;
  } finally {
    active--;
  }
}

/** When YouTube is blocking us, the time (ms) it is expected to be OK again; 0 otherwise. */
export const youtubeBlockedUntil = () => (Date.now() < blockedUntil ? blockedUntil : 0);
/** How many blocks in a row (no successful YouTube request in between). */
export const youtubeBlockStreak = () => blockStreak;
export { sleep, clock };

/** Runs yt-dlp and parses its JSON output (used to read playlists and search results). */
export const ytdlpJson = async (args, timeout = 180000) => JSON.parse(await ytdlp(args, { timeout }));

/**
 * Searches YouTube for a track. Returns up to 3 plausible uploads, best first:
 * [{ url, id, title, artist (channel), duration }].
 */
export async function findOnYoutube(track, signal) {
  const result = JSON.parse(await ytdlp(
    ['--flat-playlist', '--dump-single-json', '--no-warnings', '--', `ytsearch5:${track.artist} - ${track.title}`],
    { timeout: 120000, signal }));
  const entries = (result.entries || []).filter(e => e?.id);
  if (!entries.length) throw new Error('No YouTube match found.');
  return rankMatches(track, entries).map(e => ({
    url: `https://www.youtube.com/watch?v=${e.id}`, id: e.id, title: e.title || '',
    artist: e.channel || e.uploader || '', duration: e.duration || 0,
  }));
}

/** Downloads one URL as MP3. outTemplate is a yt-dlp template. Returns the final file path. */
export async function downloadAudio(url, outTemplate, signal) {
  const out = await ytdlp([
    '--no-playlist', '--no-progress', '--no-overwrites', '--socket-timeout', '20', '--retries', '2',
    '-x', '--audio-format', 'mp3', '--audio-quality', '320K',
    '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', outTemplate, '--print', 'after_move:filepath', '--', url,
  ], { signal });
  const file = out.trim().split(/\r?\n/).pop();
  if (!file) throw new Error('yt-dlp finished without producing a file.');
  return file;
}

/** Overwrites title/artist/album/track tags with the platform's values (cover art is kept). */
export async function tagFile(file, track, signal) {
  const tmp = file.replace(/\.mp3$/, '.tagged.mp3');
  const meta = [['title', track.title], ['artist', track.artist], ['album', track.album], ['track', track.number], ['isrc', track.isrc]]
    .filter(([, v]) => v).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  try {
    await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', ...meta, tmp], { timeout: 60000, signal });
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await rm(file, { force: true });
  await rename(tmp, file);
}
