import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFtp } from './ftp-fixture.mjs';
import { openSession, plainError, safeName, testConnection } from '../modules/cloud/remote.mjs';

let ftp;
const local = mkdtempSync(join(tmpdir(), 'musehik-local-'));
before(async () => { ftp = await startFtp(); });
after(() => ftp.close());

test('round trip upload, list, download, rename, remove', async () => {
  const src = join(local, 'song.mp3');
  writeFileSync(src, Buffer.alloc(5000, 7));
  const s = await openSession(ftp.settings);
  try {
    await s.upload(src, 'songs/A - B.part.mp3');
    await s.rename('songs/A - B.part.mp3', 'songs/A - B.mp3');
    assert.deepEqual((await s.list('songs')).map(({ name, size }) => ({ name, size })), [{ name: 'A - B.mp3', size: 5000 }]);
    assert.ok(existsSync(join(ftp.root, 'music', 'songs', 'A - B.mp3')), 'lands inside the cloud folder');
    const back = join(local, 'back.mp3');
    await s.download('songs/A - B.mp3', back);
    assert.deepEqual(readFileSync(back), readFileSync(src));
    await s.remove('songs/A - B.mp3');
    assert.deepEqual(await s.list('songs'), []);
  } finally { await s.close(); }
});

test('readJson returns null for a missing file, and reads back what writeJson wrote', async () => {
  const s = await openSession(ftp.settings);
  try {
    assert.equal(await s.readJson('nothing.json'), null);
    await s.writeJson('library.json', { version: 1, songs: [] });
    assert.deepEqual(await s.readJson('library.json'), { version: 1, songs: [] });
  } finally { await s.close(); }
});

test('list of a folder that does not exist is empty', async () => {
  const s = await openSession(ftp.settings);
  try { assert.deepEqual(await s.list('nowhere'), []); } finally { await s.close(); }
});

test('bytes counts uploads and downloads', async () => {
  const src = join(local, 'count.mp3');
  writeFileSync(src, Buffer.alloc(3000, 1));
  const s = await openSession(ftp.settings);
  try {
    await s.upload(src, 'songs/count.mp3');
    assert.ok(s.bytes >= 3000, `after upload: ${s.bytes}`);
    await s.download('songs/count.mp3', join(local, 'count-back.mp3'));
    assert.ok(s.bytes >= 6000, `after download: ${s.bytes}`);
  } finally { await s.close(); }
});

test('refuses paths outside the folder', async () => {
  for (const bad of ['../x', 'songs/../../x', '/etc/x', 'a\\b', 'C:x', '', '.']) {
    assert.throws(() => safeName(bad), /not allowed/, bad);
  }
  assert.equal(safeName('songs/Artist - Title.mp3'), 'songs/Artist - Title.mp3');
  const s = await openSession(ftp.settings);
  try { await assert.rejects(s.readJson('../outside.json'), /not allowed/); } finally { await s.close(); }
});

test('connection errors never contain the password', async () => {
  const wrong = { ...ftp.settings, password: 'p4ss-UNIQUE' };
  await assert.rejects(openSession(wrong), e => {
    assert.match(e.message, /^Cloud: /);
    assert.equal(e.message.includes('p4ss-UNIQUE'), false);
    assert.equal(String(e.stack).includes('p4ss-UNIQUE'), false);
    return true;
  });
});

test('testConnection reports plain FTP when TLS is unavailable', async () => {
  assert.deepEqual(await testConnection(ftp.settings), { ok: true, secure: false });
  const strict = await testConnection({ ...ftp.settings, allowPlainFtp: false });
  assert.equal(strict.ok, false);
  assert.match(strict.error, /only without encryption/);
});

test('certificate problems are explained, not reported as "no encryption"', () => {
  const settings = { host: 'ftp.mysite.fr', password: 'pw' };
  const mismatch = plainError(Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: ftp.mysite.fr. is not in the cert's altnames: DNS:*.lwspanel.com, DNS:lwspanel.com"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), settings);
  assert.match(mismatch.message, /certificate is made for \*\.lwspanel\.com, lwspanel\.com/);
  assert.match(mismatch.message, /instead of ftp\.mysite\.fr/);
  const selfSigned = plainError(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), settings);
  assert.match(selfSigned.message, /certificate is not trusted/);
});
