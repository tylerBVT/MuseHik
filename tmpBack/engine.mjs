// Download engine: finds audio on YouTube (yt-dlp) and writes tagged MP3 files (ffmpeg).
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestMatch } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const outputDir = resolve(process.env.MUSIC_DIR || join(root, '..', 'downloadedMusic'));
export const python = process.env.PYTHON_BIN || join(root, '.venv', 'Scripts', 'python.exe');
const launcher = join(root, 'ytdlp_launcher.py'); // yt-dlp + DNS fallback (see file header)
const ffmpeg = process.env.FFMPEG_BIN
  || join(root, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

function run(command, args, timeout = 600000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out.')); }, timeout);
    child.stdout.on('data', b => (out += b));
    child.stderr.on('data', b => (err = (err + b).slice(-4000)));
    child.on('error', e => { clearTimeout(timer); reject(new Error(e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolvePromise(out) : reject(new Error(err.trim().split('\n').pop() || `exit code ${code}`));
    });
  });
}
const ytdlp = (args, timeout) =>
  run(python, [launcher, '--ignore-config', '--js-runtimes', 'node', '--ffmpeg-location', ffmpeg, ...args], timeout);

/** Searches YouTube for a track and returns the URL of the best-scoring result. */
export async function findOnYoutube(track) {
  const result = JSON.parse(await ytdlp(
    ['--flat-playlist', '--dump-single-json', '--no-warnings', '--', `ytsearch5:${track.artist} - ${track.title}`], 120000));
  const entries = (result.entries || []).filter(e => e?.id);
  if (!entries.length) throw new Error('No YouTube match found.');
  return `https://www.youtube.com/watch?v=${bestMatch(track, entries).id}`;
}

/** Downloads one URL as MP3. outTemplate is a yt-dlp template. Returns the final file path. */
export async function downloadAudio(url, outTemplate) {
  const out = await ytdlp([
    '--no-playlist', '--no-progress', '--no-overwrites', '--socket-timeout', '20', '--retries', '2',
    '-x', '--audio-format', 'mp3', '--audio-quality', '320K',
    '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', outTemplate, '--print', 'after_move:filepath', '--', url,
  ]);
  const file = out.trim().split(/\r?\n/).pop();
  if (!file) throw new Error('yt-dlp finished without producing a file.');
  return file;
}

/** Overwrites title/artist/album/track tags with the platform's values (cover art is kept). */
export async function tagFile(file, track) {
  const tmp = file.replace(/\.mp3$/, '.tagged.mp3');
  const meta = [['title', track.title], ['artist', track.artist], ['album', track.album], ['track', track.number]]
    .filter(([, v]) => v).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', ...meta, tmp], 60000);
  await rm(file, { force: true });
  await rename(tmp, file);
}
