// The installer carries a Python with yt-dlp and ffmpeg (resources/python, read-only). It is copied once to
// %LOCALAPPDATA%\MuseHik\python, where MuseHik's yt-dlp updater can upgrade it (YouTube breaks yt-dlp every few weeks).
// musehik-python.json holds an id of the bundled build: the copy is replaced only when an app update ships another one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = 'musehik-python.json';
const idOf = dir => {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), 'utf8')).id ?? null;
  } catch {
    return null;
  }
};

/** The copy is missing, unfinished or from another bundled build. */
export const needsCopy = (template, target) => idOf(target) === null || idOf(target) !== idOf(template);

/** Copies the bundled Python to `target` when needed. The marker is written last, so a cut-off copy is redone. */
export async function ensurePython(template, target) {
  if (!needsCopy(template, target)) return { copied: false };
  await rm(target, { recursive: true, force: true });
  await cp(template, target, { recursive: true, filter: src => !src.endsWith(MARKER) });
  await cp(join(template, MARKER), join(target, MARKER));
  return { copied: true };
}

/** The ffmpeg that the imageio-ffmpeg package brings (its file name carries a version). */
export function findFfmpeg(pythonRoot) {
  const dir = join(pythonRoot, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find(name => /^ffmpeg-.*\.exe$/i.test(name));
  return exe ? join(dir, exe) : null;
}
