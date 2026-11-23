// Each library song keeps the date its file appeared on this laptop ("downloaded on").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-dates-'));
mkdirSync(join(tmp, 'music'));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
const { db, listTracks, scanLibrary } = await import('../core/library.mjs');

const file = join(tmp, 'music', 'Date Artist - Date Song.mp3');
const row = () => listTracks().find(t => t.title === 'Date Song');

test('a new song gets the date its file appeared', async () => {
  writeFileSync(file, makeMp3({ title: 'Date Song', artist: 'Date Artist' }));
  await scanLibrary();
  const { addedAt } = row();
  assert.ok(addedAt, 'has a date');
  const info = statSync(file);
  assert.equal(Date.parse(addedAt), Math.floor(info.birthtimeMs || info.mtimeMs));
  assert.ok(Math.abs(Date.now() - Date.parse(addedAt)) < 60_000);
  assert.equal('added_ms' in row(), false, 'the API sends addedAt only');
});

test('re-reading a changed file keeps its date', async () => {
  const first = row().addedAt;
  await new Promise(r => setTimeout(r, 30));
  writeFileSync(file, makeMp3({ title: 'Date Song', artist: 'Date Artist', seconds: 4 })); // new size: re-read
  await scanLibrary();
  assert.equal(row().addedAt, first);
  assert.ok(row().duration > 3.5, 'the file was read again');
});

test('songs indexed before dates existed get one on the next scan', async () => {
  db.exec('UPDATE tracks SET added_ms = NULL');
  assert.equal(row().addedAt, null);
  await scanLibrary();
  assert.ok(row().addedAt);
});
