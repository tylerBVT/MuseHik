// The bundled Python (with yt-dlp) is copied to a writable folder so yt-dlp can update itself there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePython, findFfmpeg } from '../python.mjs';

function template(id) {
  const dir = mkdtempSync(join(tmpdir(), 'musehik-pytemplate-'));
  writeFileSync(join(dir, 'python.exe'), 'fake');
  writeFileSync(join(dir, 'musehik-python.json'), JSON.stringify({ id }));
  return dir;
}

test('copies when nothing is there', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'musehik-py-')), 'python');
  assert.deepEqual(await ensurePython(template('a'), target), { copied: true });
  assert.ok(existsSync(join(target, 'python.exe')));
});

test('does nothing when the id matches (a file added by pip survives)', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'musehik-py-')), 'python');
  await ensurePython(template('a'), target);
  writeFileSync(join(target, 'yt-dlp-newer.txt'), 'updated by pip');
  assert.deepEqual(await ensurePython(template('a'), target), { copied: false });
  assert.ok(existsSync(join(target, 'yt-dlp-newer.txt')));
});

test('replaces when the id changed', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'musehik-py-')), 'python');
  await ensurePython(template('a'), target);
  writeFileSync(join(target, 'old-leftover.txt'), 'x');
  assert.deepEqual(await ensurePython(template('b'), target), { copied: true });
  assert.equal(JSON.parse(readFileSync(join(target, 'musehik-python.json'), 'utf8')).id, 'b');
  assert.equal(existsSync(join(target, 'old-leftover.txt')), false);
});

test('needsCopy tells beforehand (for the "first start" message)', async () => {
  const { needsCopy } = await import('../python.mjs');
  const target = join(mkdtempSync(join(tmpdir(), 'musehik-py-')), 'python');
  const t = template('a');
  assert.equal(needsCopy(t, target), true);
  await ensurePython(t, target);
  assert.equal(needsCopy(t, target), false);
});

test('findFfmpeg finds the versioned exe', () => {
  const root = mkdtempSync(join(tmpdir(), 'musehik-ff-'));
  const bin = join(root, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'README.md'), '');
  writeFileSync(join(bin, 'ffmpeg-win-x86_64-v9.0.2.exe'), '');
  assert.equal(findFfmpeg(root), join(bin, 'ffmpeg-win-x86_64-v9.0.2.exe'));
});

test('findFfmpeg returns null when missing', () => {
  assert.equal(findFfmpeg(mkdtempSync(join(tmpdir(), 'musehik-ff-'))), null);
});
