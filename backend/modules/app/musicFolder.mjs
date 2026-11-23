// Settings > Music folder: switch the library to another folder while the app runs, moving the songs there or not.
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { musicDir, saveAppSettings } from '../../core/config.mjs';
import { AUDIO_EXTS, freePath, listTracks, movePath, scanLibrary } from '../../core/library.mjs';
import { activeSave } from '../cloud/save.mjs';
import { activeUpload } from '../cloud/upload.mjs';
import { separating } from '../instrumentalSeparator/jobs.mjs';
import { activeJob } from '../musicDownloader/jobs.mjs';

/** A refusal the API answers with `status` (400 bad folder, 409 busy). */
export class FolderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let renameFile = rename;
let isBusy = () => Boolean(activeJob() || activeUpload() || activeSave() || separating());
let changing = false;

/** Tests only: replace fs rename (to simulate another drive) and the "something is running" check. null = the real one. */
export const setRename = fn => { renameFile = fn ?? rename; };
export const setBusyCheck = fn => { isBusy = fn ?? (() => Boolean(activeJob() || activeUpload() || activeSave() || separating())); };

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
/** `inner` is `outer` itself or somewhere below it. */
const inside = (inner, outer) => {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

async function* audioFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* audioFiles(full);
    else if (AUDIO_EXTS.has(extname(entry.name).toLowerCase()) && !/\.part\.\w+$/i.test(entry.name)) yield full;
  }
}

/** Moves one file, across drives too (rename cannot: copy, then delete the original). */
async function moveFile(from, to) {
  try {
    await renameFile(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await copyFile(from, to);
    await unlink(from);
  }
}

async function checkTarget(path, current) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new FolderError('The music folder must be a full path, like C:\\Users\\you\\Music.');
  const target = resolve(path);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) throw new FolderError(`The folder "${target}" does not exist.`);
  const [a, b] = process.platform === 'win32' ? [target.toLowerCase(), current.toLowerCase()] : [target, current];
  if (same(target, current)) throw new FolderError('This is already the music folder.');
  if (inside(a, b)) throw new FolderError('Choose a folder that is not inside the current music folder.');
  if (inside(b, a)) throw new FolderError('Choose a folder that does not contain the current music folder.');
  return target;
}

/**
 * Makes `path` the music folder. move: true moves every song (subfolders kept, never over another file) and keeps
 * its library row; move: false leaves the old songs where they are (they leave the library). Then rescans.
 */
export async function changeMusicDir(path, { move }) {
  const current = musicDir();
  const target = await checkTarget(path, current);
  if (changing || isBusy()) throw new FolderError('Wait until the download, upload or separation is finished.', 409);
  changing = true;
  try {
    let moved = 0;
    const failed = [];
    if (move) {
      for await (const file of audioFiles(current)) {
        const rel = relative(current, file);
        try {
          const dir = join(target, dirname(rel));
          await mkdir(dir, { recursive: true });
          const ext = extname(file);
          const to = freePath(dir, basename(file, ext), ext);
          await moveFile(file, to);
          movePath(file, to);
          moved++;
        } catch (e) {
          failed.push({ file: rel, error: e.message });
        }
      }
    }
    saveAppSettings({ musicDir: target });
    await scanLibrary();
    return { musicDir: target, moved, failed, total: listTracks().length };
  } finally {
    changing = false;
  }
}
