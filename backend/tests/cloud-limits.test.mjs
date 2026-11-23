import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLOUD_SETTINGS = join(mkdtempSync(join(tmpdir(), 'cloud-settings-')), 'cloud.json');
const { checkStorage, LimitError, monthKey, usageSummary } = await import('../modules/cloud/limits.mjs');
const { isConfigured, loadSettings, publicSettings, saveSettings } = await import('../modules/cloud/settings.mjs');

const GB = 1e9;

test('monthKey pads the month', () => {
  assert.equal(monthKey(new Date(2026, 2, 9)), '2026-03');
  assert.equal(monthKey(new Date(2026, 10, 21)), '2026-11');
});

test('usageSummary: storage bar warns at 80 %, traffic is only counted', () => {
  const settings = { storageLimitGB: 30 };
  const date = new Date(2026, 10, 21);
  const s = usageSummary({ usage: { months: { '2026-11': { bytes: 80 * GB } } }, settings, storedBytes: 24 * GB, date });
  assert.equal(s.month, '2026-11');
  assert.equal(s.usedBytes, 80 * GB, 'any amount of traffic is fine');
  assert.equal(s.storedBytes, 24 * GB);
  assert.equal(s.storageLimitBytes, 30 * GB);
  assert.equal(s.percent, 80);
  assert.equal(s.warning, true);
  assert.equal('limitBytes' in s, false);
  assert.equal('reached' in s, false);

  const calm = usageSummary({ usage: null, settings, storedBytes: 3 * GB, date });
  assert.equal(calm.usedBytes, 0);
  assert.equal(calm.percent, 10);
  assert.equal(calm.warning, false);
});

test('checkStorage refuses past the storage cap', () => {
  assert.doesNotThrow(() => checkStorage({ storedBytes: 29 * GB, storageLimitBytes: 30 * GB, bytes: 0.5 * GB }));
  assert.throws(() => checkStorage({ storedBytes: 29.9 * GB, storageLimitBytes: 30 * GB, bytes: 2e8 }),
    e => e instanceof LimitError && /Not enough cloud storage/.test(e.message));
});

test('settings have the agreed defaults', () => {
  const s = loadSettings();
  assert.equal(s.folder, 'music');
  assert.equal(s.port, 21);
  assert.equal('monthlyLimitGB' in s, false);
  assert.equal(s.storageLimitGB, 30);
  assert.equal(s.cacheLimitGB, 2);
  assert.equal(s.allowPlainFtp, false);
  assert.equal(isConfigured(s), false);
});

test('saveSettings keeps the password when none is sent', () => {
  saveSettings({ host: 'ftp.example.com', user: 'me', password: 'first-secret' });
  const saved = saveSettings({ host: 'ftp.example.com', user: 'me', password: '' });
  assert.equal(saved.password, 'first-secret');
  assert.equal(loadSettings().password, 'first-secret');
  assert.equal(isConfigured(loadSettings()), true);
});

test('publicSettings hides the password', () => {
  const pub = publicSettings(loadSettings());
  assert.equal('password' in pub, false);
  assert.equal(pub.hasPassword, true);
  assert.equal(JSON.stringify(pub).includes('first-secret'), false);
});

test('a settings file saved with the old monthly limit loses it', () => {
  writeFileSync(process.env.CLOUD_SETTINGS, JSON.stringify({ ...loadSettings(), monthlyLimitGB: 10 }));
  assert.equal('monthlyLimitGB' in loadSettings(), false);
  assert.equal('monthlyLimitGB' in saveSettings({ name: 'Tyler' }), false);
});
