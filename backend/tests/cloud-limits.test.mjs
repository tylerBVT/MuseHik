import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLOUD_SETTINGS = join(mkdtempSync(join(tmpdir(), 'cloud-settings-')), 'cloud.json');
const { usageSummary } = await import('../modules/cloud/limits.mjs');
const { isConfigured, loadSettings, publicSettings, saveSettings } = await import('../modules/cloud/settings.mjs');

const GB = 1e9;

test('usageSummary: storage bar against the cap the server reports, warns at 80 %', () => {
  const s = usageSummary({ storedBytes: 24 * GB, storageLimitBytes: 30 * GB });
  assert.equal(s.storedBytes, 24 * GB);
  assert.equal(s.storageLimitBytes, 30 * GB);
  assert.equal(s.percent, 80);
  assert.equal(s.warning, true);
  const calm = usageSummary({ storedBytes: 3 * GB, storageLimitBytes: 30 * GB });
  assert.equal(calm.percent, 10);
  assert.equal(calm.warning, false);
});

test('settings have the agreed defaults: no FTP fields, not set up', () => {
  const s = loadSettings();
  assert.deepEqual(s, { url: '', key: '', name: '', cacheLimitGB: 2, online: true });
  assert.equal(isConfigured(s), false);
});

test('an old FTP settings file loads without its FTP fields, and saving drops them for good', () => {
  writeFileSync(process.env.CLOUD_SETTINGS, JSON.stringify({
    host: 'ftp.example.com', port: 21, user: 'me', password: 'ftp-secret', folder: 'music', name: 'Tyler',
    storageLimitGB: 30, cacheLimitGB: 3, allowPlainFtp: true, online: true, monthlyLimitGB: 10,
  }));
  assert.deepEqual(loadSettings(), { url: '', key: '', name: 'Tyler', cacheLimitGB: 3, online: true });
  saveSettings({ name: 'Tyler' });
  assert.equal(readFileSync(process.env.CLOUD_SETTINGS, 'utf8').includes('ftp-secret'), false);
});

test('the address is cleaned up: https:// added, trailing slashes dropped', () => {
  assert.equal(saveSettings({ url: ' www.example.com/music-api/ ' }).url, 'https://www.example.com/music-api');
  assert.equal(saveSettings({ url: 'http://192.168.1.10:8000' }).url, 'http://192.168.1.10:8000');
  assert.throws(() => saveSettings({ url: 'ftp://example.com' }), /address/);
  assert.throws(() => saveSettings({ url: 'https://' }), /address/);
});

test('saveSettings keeps the key when none is sent', () => {
  saveSettings({ url: 'https://example.com/music-api', key: 'first-secret' });
  const saved = saveSettings({ key: '' });
  assert.equal(saved.key, 'first-secret');
  assert.equal(isConfigured(loadSettings()), true);
});

test('publicSettings hides the key', () => {
  const pub = publicSettings(loadSettings());
  assert.equal('key' in pub, false);
  assert.equal(pub.hasKey, true);
  assert.equal(JSON.stringify(pub).includes('first-secret'), false);
});

test('bad numbers and long names are refused', () => {
  assert.throws(() => saveSettings({ cacheLimitGB: 0 }), /Cache size/);
  assert.throws(() => saveSettings({ name: 'x'.repeat(41) }), /too long/);
});
