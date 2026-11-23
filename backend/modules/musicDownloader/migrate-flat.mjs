// One-off: flattens an older music folder (playlist sub-folders, "NN - Artist - Title.mp3" names) into the
// flat "Artist - Title.ext" layout. Dry run by default; pass --apply to really move files.
// Never overwrites: if the target name already exists the file is left where it is and reported.
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { dataDir, musicDir } from '../../core/config.mjs';
const outputDir = musicDir();
import { AUDIO_EXTS } from '../../core/library.mjs';

const apply = process.argv.includes('--apply');
const stripNumber = name => name.replace(/^\d{1,4} - /, '');

const moves = [], conflicts = [], others = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    if (!AUDIO_EXTS.has(extname(entry.name).toLowerCase())) {
      if (entry.name !== '.gitkeep') others.push(full);
      continue;
    }
    const target = join(outputDir, stripNumber(basename(full)));
    if (target === full) continue;
    if (existsSync(target)) conflicts.push({ from: full, target });
    else moves.push({ from: full, to: target });
  }
}
await walk(outputDir);

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} on ${outputDir}`);
console.log(`move/rename: ${moves.length}, name already taken (left in place): ${conflicts.length}, non-audio files: ${others.length}`);
for (const m of moves.slice(0, 5)) console.log(`  ${m.from.replace(outputDir, '.')}  ->  ${m.to.replace(outputDir, '.')}`);
if (moves.length > 5) console.log(`  ... and ${moves.length - 5} more`);
for (const c of conflicts) console.log(`  CONFLICT ${c.from.replace(outputDir, '.')} (target exists)`);
for (const o of others) console.log(`  NON-AUDIO ${o.replace(outputDir, '.')} -> moved to backend/data/legacy/`);

if (apply) {
  const legacy = join(dataDir, 'legacy');
  await mkdir(legacy, { recursive: true });
  for (const m of moves) await rename(m.from, m.to);
  for (const o of others) await rename(o, join(legacy, `${basename(dirname(o))}__${basename(o)}`));
  // Remove sub-folders that are now empty (never touches folders that still hold something).
  const dirs = [];
  const collect = async dir => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { dirs.push(join(dir, e.name)); await collect(join(dir, e.name)); }
    }
  };
  await collect(outputDir);
  for (const d of dirs.reverse()) if (!(await readdir(d)).length) await rmdir(d);
  console.log('Done.');
} else {
  console.log('Nothing changed. Re-run with --apply to do it.');
}
