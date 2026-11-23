// Writing tags into audio files (ffmpeg, no re-encoding: the sound and the cover art are kept), and deleting files
// to the Windows Recycle Bin.
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { ffmpeg } from './config.mjs';

/** Runs a program; rejects with its error output when it fails. */
function runProgram(program, args, { timeout = 60000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, signal, env: env ? { ...process.env, ...env } : undefined });
    let errors = '';
    child.stderr.on('data', d => { errors += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errors.trim().split(/\r?\n/).pop() || `${program} stopped with code ${code}`));
    });
  });
}

const TAG_NAMES = ['title', 'artist', 'album', 'genre', 'track', 'isrc'];

/**
 * Sets tags of an audio file in place. `tags`: any of title, artist, album, genre, track, isrc; a value of '' clears
 * that tag, a missing one keeps what the file has. The new file is written next to it as "*.part.<ext>" (ignored by
 * the library scan), then replaces it.
 */
export async function writeTags(path, tags, { signal } = {}) {
  const ext = extname(path);
  const tmp = `${path.slice(0, -ext.length)}.part${ext}`;
  const meta = TAG_NAMES.filter(name => tags[name] !== undefined && tags[name] !== null)
    .flatMap(name => ['-metadata', `${name}=${tags[name]}`]);
  // ID3 v2.3 for MP3s: what Windows Explorer and most players read best.
  const id3 = ext.toLowerCase() === '.mp3' ? ['-id3v2_version', '3'] : [];
  try {
    await runProgram(ffmpeg, ['-v', 'error', '-y', '-i', path, '-map', '0', '-c', 'copy', ...meta, ...id3, tmp], { signal });
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await rename(tmp, path);
}

/** Moves a file to the Windows Recycle Bin (MUSEHIK_TRASH=delete: deletes it instead, for tests). */
export async function moveToTrash(path) {
  if (process.env.MUSEHIK_TRASH === 'delete') return rm(path);
  const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
    + "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:MUSEHIK_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  // The path travels in an environment variable: no quoting problem whatever characters it has.
  await runProgram('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { MUSEHIK_TRASH_PATH: path } });
}
