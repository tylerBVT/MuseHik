// Download reports: after every download, a plain-text summary of what went wrong (and what might have gone wrong
// silently) plus the full data, saved in backend/data/download-reports/. Meant to be read by a person, pasted to
// a developer, and compared between runs to improve the downloader.
//   <date> <name>.txt   the report (also served by GET /api/download/history/:id/report)
//   <date> <name>.json  everything the job recorded
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../../core/config.mjs';
import { safeName } from '../../core/lib.mjs';

export const reportsDir = join(dataDir, 'download-reports');

const time = s => {
  if (!s) return '?';
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
const songLine = (s, fallback) => {
  if (!s) return fallback;
  const name = s.title ? `${s.artist ? `${s.artist} - ` : ''}${s.title}` : s.url || fallback;
  const extra = [s.album, s.duration ? time(s.duration) : '', s.isrc ? `ISRC ${s.isrc}` : ''].filter(Boolean).join(', ');
  return `${s.number ? `#${s.number} ` : ''}${name}${extra ? ` (${extra})` : ''}`;
};
const uploadLine = u => `${u.url}${u.title ? ` "${u.title}"` : ''}${u.channel ? ` by ${u.channel}` : ''}${u.duration ? ` (${time(u.duration)})` : ''}`;
const indent = (text, pad) => String(text).split('\n').map(l => pad + l).join('\n');

/**
 * Downloads that may be the wrong recording: length far from the platform's, or the upload's title/channel
 * missing words of the song title. Not errors, but worth a listen.
 */
export function suspicious(item) {
  const { song, used } = item;
  if (!song?.title || !used) return null;
  const reasons = [];
  if (song.duration && used.duration && Math.abs(song.duration - used.duration) > 10) {
    reasons.push(`length ${time(used.duration)} instead of ${time(song.duration)}`);
  }
  const have = new Set([...words(used.title), ...words(used.channel)]);
  const missing = words(song.title).filter(w => !have.has(w));
  if (missing.length) reasons.push(`upload title lacks "${missing.join(' ')}"`);
  if (used.rank > 1) reasons.push(`best match failed, used upload #${used.rank}`);
  return reasons.length ? reasons.join('; ') : null;
}

/** The report as plain text. */
export function renderReport(job) {
  const out = [];
  const add = (...lines) => out.push(...lines);
  const failed = job.failed || [];
  const skipped = job.skippedList || [];
  const downloaded = job.downloaded || [];
  const notTried = job.notTried || [];

  add('MuseHik download report', '=======================');
  add(`Link:      ${job.url}`);
  add(`Name:      ${job.name || '(single link)'} (${job.platform || 'unknown platform'})`);
  add(`When:      ${job.startedAt} -> ${job.finishedAt || 'still running'}`);
  add(`yt-dlp:    ${job.ytdlp || 'unknown version'}`);
  add(`Status:    ${job.status}${job.error ? ` - ${job.error}` : ''}`);
  add(`Songs:     ${job.total} in the link: ${downloaded.length || (job.files || []).length} downloaded, `
    + `${skipped.length} skipped, ${failed.length} failed, ${notTried.length} not tried`);
  if (job.pauses) add(`Pauses:    ${job.pauses} (YouTube blocking, ~${job.pausedMinutes} min)`);
  for (const note of job.notes || []) add(`Note:      ${note}`);
  if (job.detail) add('', 'Job error output:', indent(job.detail, '  '));

  if (failed.length) {
    const groups = new Map();
    for (const f of failed) {
      const key = `[${f.kind || 'other'}] ${f.error}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    add('', `FAILED BY REASON (${failed.length})`, '-----------------');
    for (const [reason, count] of [...groups].sort((a, b) => b[1] - a[1])) add(`${String(count).padStart(5)}  ${reason}`);

    add('', `FAILED SONGS (${failed.length})`, '------------');
    for (const f of failed) {
      add(songLine(f.song, f.track));
      add(`  why:    [${f.kind || 'other'}] ${f.error}`);
      if (f.stage) add(`  step:   ${f.stage}`);
      for (const [i, c] of (f.candidates || []).entries()) {
        const attempt = (f.attempts || []).find(a => a.url === c.url);
        const outcome = attempt ? attempt.error : f.attempts?.length ? 'not tried' : '';
        add(`  upload ${i + 1}: ${uploadLine(c)}${outcome ? `\n            -> ${outcome}` : ''}`);
      }
      if (f.detail) add('  output:', indent(f.detail, '    '));
      add('');
    }
  }

  if (notTried.length) {
    add('', `NOT TRIED (${notTried.length})`, '---------');
    for (const t of notTried) add(t);
  }

  const odd = downloaded.map(d => ({ d, why: suspicious(d) })).filter(x => x.why);
  if (odd.length) {
    add('', `DOWNLOADED, MAYBE THE WRONG VERSION (${odd.length})`, '-----------------------------------');
    for (const { d, why } of odd) {
      add(songLine(d.song, d.track), `  got:    ${uploadLine(d.used)}`, `  check:  ${why}`, `  file:   ${d.file}`, '');
    }
  }

  if (skipped.length) {
    add('', `SKIPPED (${skipped.length})`, '-------');
    for (const s of skipped) {
      add(songLine(s.song, s.track));
      if (s.match) {
        add(`  same as: #${s.match.id} ${s.match.artist ? `${s.match.artist} - ` : ''}${s.match.title} (${time(s.match.duration)}) `
          + `[${s.match.matchedBy}] file "${s.match.file}"`);
        if (s.match.via) add(`  via:     ${uploadLine(s.match.via)}`);
      } else {
        add(`  why:     ${s.reason}`);
      }
    }
  }

  if (!failed.length && !notTried.length && !odd.length) add('', 'No problems found.');
  return `${out.join('\n')}\n`;
}

/** Writes the .txt report and the .json data. Returns the .txt path. */
export async function saveReport(job) {
  await mkdir(reportsDir, { recursive: true });
  // "2026-11-17 18h01m13": seconds included, so two downloads started in the same minute keep separate reports.
  const stamp = (job.startedAt || new Date().toISOString()).slice(0, 19).replace('T', ' ').replace(':', 'h').replace(':', 'm');
  const base = join(reportsDir, safeName(`${stamp} ${job.name || job.platform || 'download'}`));
  await writeFile(`${base}.json`, JSON.stringify(job, null, 2));
  await writeFile(`${base}.txt`, renderReport(job));
  return `${base}.txt`;
}
