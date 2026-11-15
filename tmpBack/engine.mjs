// Download engine: finds audio on YouTube (yt-dlp) and writes tagged MP3 files (ffmpeg).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestMatch } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));

/** Reads tmpBack/config.json (see config.example.json). Missing file = defaults. */
function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`tmpBack/config.json is not valid JSON (remember to double the backslashes): ${e.message}`);
  }
}
const config = loadConfig();

// Priority: MUSIC_DIR env var > config.json "musicDir" > ../downloadedMusic
export const outputDir = resolve(process.env.MUSIC_DIR || config.musicDir || join(root, '..', 'downloadedMusic'));
export const python = process.env.PYTHON_BIN || join(root, '.venv', 'Scripts', 'python.exe');
const launcher = join(root, 'ytdlp_launcher.py'); // yt-dlp + DNS fallback (see file header)
const ffmpeg = process.env.FFMPEG_BIN
  || join(root, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

/** Kills a process and its children (yt-dlp starts ffmpeg; plain kill() would leave it running on Windows). */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill();
}

/** Runs a program. An AbortSignal kills it (used by the Stop button). */
function run(command, args, { timeout = 600000, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    const child = spawn(command, args, { shell: false });
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
      code === 0 ? resolvePromise(out) : reject(new Error(err.trim().split('\n').pop() || `exit code ${code}`));
    });
  });
}
const ytdlp = (args, options) =>
  run(python, [launcher, '--ignore-config', '--js-runtimes', 'node', '--ffmpeg-location', ffmpeg, ...args], options);

/** Runs yt-dlp and parses its JSON output (used to read playlists and search results). */
export const ytdlpJson = async (args, timeout = 180000) => JSON.parse(await ytdlp(args, { timeout }));

/** Searches YouTube for a track and returns the URL of the best-scoring result. */
export async function findOnYoutube(track, signal) {
  const result = JSON.parse(await ytdlp(
    ['--flat-playlist', '--dump-single-json', '--no-warnings', '--', `ytsearch5:${track.artist} - ${track.title}`],
    { timeout: 120000, signal }));
  const entries = (result.entries || []).filter(e => e?.id);
  if (!entries.length) throw new Error('No YouTube match found.');
  return `https://www.youtube.com/watch?v=${bestMatch(track, entries).id}`;
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
