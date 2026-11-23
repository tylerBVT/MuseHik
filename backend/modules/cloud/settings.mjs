// Cloud connection settings, stored on this laptop only (backend/data/cloud.json, git-ignored).
// The password never leaves this file: the API sends `hasPassword` instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../../core/config.mjs';

const file = () => process.env.CLOUD_SETTINGS || join(dataDir, 'cloud.json');

/** Another local cloud file kept next to the settings (e.g. the offline copy of the cloud index). */
export const localFile = name => join(dirname(file()), name);

export const DEFAULTS = Object.freeze({
  host: '', port: 21, user: '', password: '', folder: 'music', name: '',
  storageLimitGB: 30, cacheLimitGB: 2, allowPlainFtp: false,
});

export function loadSettings() {
  try {
    // monthlyLimitGB: an old setting (the hosting has no traffic limit), dropped from files saved before.
    const { monthlyLimitGB, ...saved } = JSON.parse(readFileSync(file(), 'utf8'));
    return { ...DEFAULTS, ...saved };
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`The cloud settings file is damaged (${file()}): ${e.message}`);
  }
}

const positive = (value, name) => {
  const n = Number(value);
  if (!(n > 0)) throw new Error(`${name} must be a number above 0.`);
  return n;
};

/** Merges `patch` into the saved settings. An empty or missing password keeps the saved one. */
export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current };
  for (const key of ['host', 'user', 'folder', 'name']) if (patch[key] !== undefined) next[key] = String(patch[key]).trim();
  if (next.name.length > 40) throw new Error('Your name is too long (40 characters max).');
  if (patch.password) next.password = String(patch.password);
  if (patch.port !== undefined) next.port = positive(patch.port, 'Port');
  if (patch.storageLimitGB !== undefined) next.storageLimitGB = positive(patch.storageLimitGB, 'Storage limit');
  if (patch.cacheLimitGB !== undefined) next.cacheLimitGB = positive(patch.cacheLimitGB, 'Cache size');
  if (patch.allowPlainFtp !== undefined) next.allowPlainFtp = Boolean(patch.allowPlainFtp);
  next.folder = next.folder.replace(/^\/+|\/+$/g, '');
  if (!next.folder || next.folder.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('The cloud folder must be a plain folder name like "music".');
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

export function publicSettings(settings) {
  const { password, ...rest } = settings;
  return { ...rest, hasPassword: Boolean(password) };
}

export const isConfigured = s => Boolean(s.host && s.user && s.password);
