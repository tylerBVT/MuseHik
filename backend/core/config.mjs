// Shared settings for every backend module: where the music lives, where the Python venv is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The backend/ folder (config.json, .venv, data/ live here). */
export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads backend/config.json (see config.example.json). Missing file = defaults. */
function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(backendRoot, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`backend/config.json is not valid JSON (remember to double the backslashes): ${e.message}`);
  }
}
export const config = loadConfig();

/** Running as the installed Windows app (set by desktop/), not from the code folder. */
export const installed = process.env.MUSEHIK_INSTALLED === '1';

/** Settings, library index, reports. The installed app puts them in %APPDATA%\MuseHik (the code folder is read-only). */
export const dataDir = resolve(process.env.MUSEHIK_DATA_DIR || join(backendRoot, 'data'));
export const python = process.env.PYTHON_BIN || join(backendRoot, '.venv', 'Scripts', 'python.exe');
export const ffmpeg = process.env.FFMPEG_BIN
  || join(backendRoot, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

// Big, re-downloadable files (separator Python env with PyTorch, AI models, cloned repos) live OUTSIDE the project,
// so OneDrive does not sync gigabytes. Priority: MUSEHIK_HEAVY_DIR env > config.json "heavyDir" > ~/MuseHikData
export const heavyDir = resolve(process.env.MUSEHIK_HEAVY_DIR || config.heavyDir || join(homedir(), 'MuseHikData'));
export const separatorPython = process.env.SEPARATOR_PYTHON || join(heavyDir, 'separator-venv', 'Scripts', 'python.exe');
export const separatorModelsDir = join(heavyDir, 'models');

// App settings chosen in the app (Settings page), kept per laptop: <dataDir>/app-settings.json
export const PROFILES = ['poontje', 'muttmutt'];
const appSettingsFile = () => join(dataDir, 'app-settings.json');

/** The saved app settings ({ profile?, musicDir? }); a missing file means nothing was chosen yet. */
export function loadAppSettings() {
  try {
    return JSON.parse(readFileSync(appSettingsFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`The app settings file is damaged (${appSettingsFile()}): ${e.message}`);
  }
}

/** Merges `patch` ({ profile?, musicDir? }) into the saved app settings and returns them. */
export function saveAppSettings(patch) {
  const next = { ...loadAppSettings() };
  if (patch.profile !== undefined) {
    if (!PROFILES.includes(patch.profile)) throw new Error(`Unknown profile "${patch.profile}".`);
    next.profile = patch.profile;
  }
  if (patch.musicDir !== undefined) {
    if (!isAbsolute(String(patch.musicDir))) throw new Error('The music folder must be a full path, like C:\\Users\\you\\Music.');
    next.musicDir = resolve(patch.musicDir);
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(appSettingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Where the songs are. Read on every call, so a change in Settings applies at once.
 * Priority: MUSIC_DIR env var > Settings > config.json "musicDir" > default (installed: Music\MuseHik; dev: <repo>/downloadedMusic)
 */
export function musicDir() {
  return resolve(process.env.MUSIC_DIR || loadAppSettings().musicDir || config.musicDir
    || process.env.MUSEHIK_DEFAULT_MUSIC_DIR || join(backendRoot, '..', 'downloadedMusic'));
}

/** Who uses this laptop. Not chosen yet: Poontje where the AI tools are (dev mode, separator installed), else MuttMutt. */
export function profile() {
  const saved = loadAppSettings().profile;
  if (PROFILES.includes(saved)) return saved;
  return !installed || existsSync(separatorPython) ? 'poontje' : 'muttmutt';
}
