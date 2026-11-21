import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLOUD_SETTINGS = join(mkdtempSync(join(tmpdir(), 'cloud-settings-')), 'cloud.json');
const { checkStorage, checkTransfer, LimitError, limitMessage, monthKey, usageSummary } = await import('../modules/cloud/limits.mjs');
const { isConfigured, loadSettings, publicSettings, saveSettings } = await import('../modules/cloud/settings.mjs');

const GB = 1e9;

test('monthKey pads the month', () => {
  assert.equal(monthKey(new Date(2026, 2, 9)), '2026-03');
  assert.equal(monthKey(new Date(2026, 10, 21)), '2026-11');
});

test('limitMessage names this and next month', () => {
  assert.equal(limitMessage(new Date(2026, 11, 5)), 'Cloud limit reached for December. It resets on 1 January.');
  assert.equal(limitMessage(new Date(2026, 10, 21)), 'Cloud limit reached for November. It resets on 1 December.');
});

test('usageSummary warns at 80 %', () => {
  const settings = { monthlyLimitGB: 10, storageLimitGB: 30 };
  const date = new Date(2026, 10, 21);
  const warn = usageSummary({ usage: { months: { '2026-11': { bytes: 8 * GB } } }, settings, storedBytes: 4 * GB, date });
  assert.equal(warn.month, '2026-11');
  assert.equal(warn.usedBytes, 8 * GB);
  assert.equal(warn.limitBytes, 10 * GB);
  assert.equal(warn.percent, 80);
  assert.equal(warn.warning, true);
  assert.equal(warn.reached, false);
  assert.equal(warn.storedBytes, 4 * GB);
  assert.equal(warn.storageLimitBytes, 30 * GB);

  const calm = usageSummary({ usage: null, settings, storedBytes: 0, date });
  assert.equal(calm.usedBytes, 0);
  assert.equal(calm.warning, false);
  assert.equal(calm.message, null);

  const full = usageSummary({ usage: { months: { '2026-11': { bytes: 10 * GB } } }, settings, storedBytes: 0, date });
  assert.equal(full.reached, true);
  assert.equal(full.message, 'Cloud limit reached for November. It resets on 1 December.');
});

test('checkTransfer refuses past the limit', () => {
  const date = new Date(2026, 10, 21);
  assert.doesNotThrow(() => checkTransfer({ usedBytes: 9 * GB, limitBytes: 10 * GB, bytes: 0.5 * GB, date }));
  assert.throws(() => checkTransfer({ usedBytes: 9.9 * GB, limitBytes: 10 * GB, bytes: 2e8, date }),
    e => e instanceof LimitError && e.code === 'LIMIT' && /November/.test(e.message));
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
  assert.equal(s.monthlyLimitGB, 10);
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
