// App settings (backend/core/config.mjs): where the music lives (changeable from Settings) and who uses this laptop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-appsettings-'));
process.env.MUSEHIK_DATA_DIR = join(tmp, 'data');
process.env.SEPARATOR_PYTHON = join(tmp, 'no-separator', 'python.exe');
process.env.MUSEHIK_DEFAULT_MUSIC_DIR = join(tmp, 'Default Music');
delete process.env.MUSIC_DIR;
delete process.env.MUSEHIK_INSTALLED;
const dev = await import('../core/config.mjs');

test('musicDir defaults to MUSEHIK_DEFAULT_MUSIC_DIR', () => {
  // The developer's backend/config.json "musicDir" ranks above the default; the installed app has no config.json.
  assert.equal(dev.musicDir(), dev.config.musicDir ? resolve(dev.config.musicDir) : join(tmp, 'Default Music'));
});

test('musicDir follows the saved setting', () => {
  const chosen = join(tmp, 'Mütti music');
  dev.saveAppSettings({ musicDir: chosen });
  assert.equal(dev.musicDir(), chosen);
  assert.equal(dev.loadAppSettings().musicDir, chosen);
});

test('MUSIC_DIR env wins over the saved setting', () => {
  process.env.MUSIC_DIR = join(tmp, 'env music');
  try {
    assert.equal(dev.musicDir(), join(tmp, 'env music'));
  } finally {
    delete process.env.MUSIC_DIR;
  }
});

test('relative musicDir is refused', () => {
  assert.throws(() => dev.saveAppSettings({ musicDir: 'music' }), /full path/);
});

test('data dir comes from MUSEHIK_DATA_DIR', () => {
  assert.equal(dev.dataDir, join(tmp, 'data'));
});

test('profile defaults to poontje in dev mode', () => {
  assert.equal(dev.installed, false);
  assert.equal(dev.profile(), 'poontje');
});

test('saved profile wins', () => {
  dev.saveAppSettings({ profile: 'muttmutt' });
  assert.equal(dev.profile(), 'muttmutt');
  dev.saveAppSettings({ profile: 'poontje' });
  assert.equal(dev.profile(), 'poontje');
});

test('unknown profile is refused', () => {
  assert.throws(() => dev.saveAppSettings({ profile: 'mum' }), /Unknown profile "mum"/);
});

test('profile defaults to muttmutt when installed without the separator', async () => {
  process.env.MUSEHIK_INSTALLED = '1';
  process.env.MUSEHIK_DATA_DIR = join(tmp, 'installed-data');
  try {
    const app = await import('../core/config.mjs?installed'); // a second copy of the module, read with these env vars
    assert.equal(app.installed, true);
    assert.equal(app.profile(), 'muttmutt');
  } finally {
    delete process.env.MUSEHIK_INSTALLED;
    process.env.MUSEHIK_DATA_DIR = join(tmp, 'data');
  }
});
