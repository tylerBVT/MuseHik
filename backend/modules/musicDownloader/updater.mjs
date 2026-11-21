// Keeps yt-dlp up to date. yt-dlp is used exactly as its authors publish it (the pip package in backend/.venv);
// this module only asks pip for a newer release, checks that it starts, and goes back if it does not.
//   - once a day in the background (when the server runs)
//   - after a download fails in a way that usually means "YouTube changed, yt-dlp needs a fix"
//     (stable first; if stable has no newer release, the nightly build, where fixes land first)
//   - on demand from Settings, with a rollback to the previous version
// Channel "nightly" installs pre-releases. Going back to "stable" never downgrades: pip moves to the next stable
// release as soon as it is newer than the installed nightly.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, python } from '../../core/config.mjs';
import { run, whileIdle, ytdlpArgs } from './engine.mjs';

const STATE_FILE = join(dataDir, 'ytdlp-updater.json');
const PACKAGE = 'yt-dlp[default]'; // [default] also brings yt-dlp-ejs (YouTube challenge solver) in the matching version
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let state = load();
let current = null; // the running update, if any
let installed = null; // { ytdlp, ejs } cache

function load() {
  try {
    return { channel: 'stable', ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { channel: 'stable' };
  }
}
function save() {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('yt-dlp updater:', e.message); }
}

const VERSION_SCRIPT = [
  'import importlib.metadata as m',
  "for p in ('yt-dlp', 'yt-dlp-ejs'):",
  '    try: print(m.version(p))',
  "    except Exception: print('')",
].join('\n');

/** Installed versions: { ytdlp, ejs }. */
export async function versions() {
  const [ytdlp = '', ejs = ''] = (await run(python, ['-c', VERSION_SCRIPT], { timeout: 30000 })).trim().split(/\r?\n/);
  installed = { ytdlp: ytdlp.trim() || null, ejs: ejs.trim() || null };
  return installed;
}

const pip = args => run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', ...args],
  { timeout: 10 * 60 * 1000 });

/** Does the installed yt-dlp start, with its challenge solver? */
async function selfTest() {
  try {
    await run(python, ytdlpArgs(['--version']), { timeout: 60000 });
    await run(python, ['-c', 'import yt_dlp_ejs'], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

const short = e => String(e?.message || e).split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || 'unknown error';

function record(ok, message, reason) {
  state.lastCheck = new Date().toISOString();
  state.lastResult = { ok, message, reason, at: state.lastCheck };
  save();
  console.log(`yt-dlp updater (${reason}): ${message}`);
}

async function doUpdate(reason, nightly) {
  return whileIdle(async () => {
    const before = (await versions()).ytdlp;
    try {
      await pip(['-U', ...(nightly ? ['--pre'] : []), PACKAGE]);
    } catch (e) {
      record(false, `Could not update yt-dlp: ${short(e)}`, reason);
      return { changed: false, before, after: before };
    }
    const after = (await versions()).ytdlp;
    if (!(await selfTest())) {
      if (before && before !== after) await pip([`${PACKAGE}==${before}`]).catch(() => {});
      await versions();
      record(false, `yt-dlp ${after} did not start correctly, so MuseHik went back to ${before}.`, reason);
      return { changed: false, before, after: before };
    }
    if (after !== before) state.previousVersion = before;
    record(true, after !== before
      ? `Updated yt-dlp ${before} → ${after}.`
      : `yt-dlp ${after} is already the newest ${nightly ? 'nightly' : 'stable'} version.`, reason);
    return { changed: after !== before, before, after };
  });
}

/** Updates yt-dlp now (one update at a time; a second call waits for the running one). */
export async function update({ reason = 'manual', nightly = state.channel === 'nightly' } = {}) {
  while (current) await current.catch(() => {});
  current = doUpdate(reason, nightly);
  try {
    return await current;
  } finally {
    current = null;
  }
}

/**
 * Called when a download failed in a way that usually means yt-dlp is outdated. Tries stable, then nightly.
 * At most once an hour, so a video that is simply broken does not trigger endless updates.
 * Returns { changed, before, after }.
 */
export async function updateAfterFailure() {
  if (Date.now() - (state.lastFailureUpdate || 0) < HOUR) return { changed: false };
  state.lastFailureUpdate = Date.now();
  save();
  let result = await update({ reason: 'a download failed' });
  if (!result.changed && state.channel !== 'nightly') {
    result = await update({ reason: 'a download failed, stable had no fix: trying the nightly build', nightly: true });
  }
  return result;
}

/** Goes back to the version installed before the last update. */
export async function rollback() {
  const target = state.previousVersion;
  if (!target) throw new Error('There is no previous yt-dlp version to go back to.');
  while (current) await current.catch(() => {});
  current = whileIdle(async () => {
    const before = (await versions()).ytdlp;
    await pip([`${PACKAGE}==${target}`]);
    const after = (await versions()).ytdlp;
    state.previousVersion = before;
    record(after === target, after === target ? `Went back from ${before} to ${after}.` : `Could not go back to ${target}.`, 'manual rollback');
    return { changed: after !== before, before, after };
  });
  try {
    return await current;
  } finally {
    current = null;
  }
}

export function setChannel(channel) {
  if (!['stable', 'nightly'].includes(channel)) throw new Error('Channel must be "stable" or "nightly".');
  state.channel = channel;
  save();
}

/** Everything the Settings page shows. */
export async function status() {
  return {
    ...(installed || (await versions().catch(() => ({ ytdlp: null, ejs: null })))),
    channel: state.channel,
    lastCheck: state.lastCheck || null,
    lastResult: state.lastResult || null,
    previousVersion: state.previousVersion || null,
    updating: Boolean(current),
  };
}

/** Daily background check (first one shortly after start). Disabled with MUSEHIK_NO_AUTO_UPDATE=1. */
export function startAutoUpdates() {
  if (process.env.MUSEHIK_NO_AUTO_UPDATE === '1') return;
  const tick = () => {
    const last = state.lastCheck ? Date.parse(state.lastCheck) : 0;
    if (!current && Date.now() - last >= DAY) update({ reason: 'daily check' }).catch(e => console.error('yt-dlp updater:', e.message));
  };
  setTimeout(tick, 20000).unref();
  setInterval(tick, HOUR).unref();
}
