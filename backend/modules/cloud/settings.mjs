// Cloud settings, stored on this laptop only (backend/data/cloud.json, git-ignored): the music API's address and key.
// The key never leaves this file: the page gets `hasKey` instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../../core/config.mjs';

const file = () => process.env.CLOUD_SETTINGS || join(dataDir, 'cloud.json');

/** Another local cloud file kept next to the settings (e.g. the offline copy of the cloud index). */
export const localFile = name => join(dirname(file()), name);

export const DEFAULTS = Object.freeze({
  url: '', key: '', name: '', cacheLimitGB: 2,
  // Offline: this laptop never connects to the cloud (songs already on it still play).
  online: true,
});

export function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`The cloud settings file is damaged (${file()}): ${e.message}`);
  }
  // Only the known fields: a file saved by the FTP version (host, password...) loses the rest.
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (saved[key] !== undefined) settings[key] = saved[key];
  return settings;
}

/** "www.site.com/music-api/" → "https://www.site.com/music-api". Throws when it cannot be an address. */
export function cleanUrl(value) {
  let url = String(value ?? '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new Error('The cloud address must look like https://www.example.com/music-api.');
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/** Merges `patch` into the saved settings. An empty or missing key keeps the saved one. */
export function saveSettings(patch) {
  const next = loadSettings();
  if (patch.url !== undefined) next.url = cleanUrl(patch.url);
  if (patch.name !== undefined) next.name = String(patch.name).trim();
  if (next.name.length > 40) throw new Error('Your name is too long (40 characters max).');
  if (patch.key) next.key = String(patch.key).trim();
  if (patch.cacheLimitGB !== undefined) {
    const n = Number(patch.cacheLimitGB);
    if (!(n > 0)) throw new Error('Cache size must be a number above 0.');
    next.cacheLimitGB = n;
  }
  if (patch.online !== undefined) next.online = Boolean(patch.online);
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

export function publicSettings(settings) {
  const { key, ...rest } = settings;
  return { ...rest, hasKey: Boolean(key) };
}

export const isConfigured = s => Boolean(s.url && s.key);

/** Set up, and allowed to connect on this laptop (the Online / Offline switch in Settings). */
export const isOnline = s => isConfigured(s) && s.online !== false;

export const OFFLINE_MESSAGE = 'The cloud is offline on this laptop. Turn it on in Settings.';
