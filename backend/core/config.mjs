// Shared settings for every backend module: where the music lives, where the Python venv is.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

// Priority: MUSIC_DIR env var > config.json "musicDir" > <repo>/downloadedMusic
export const outputDir = resolve(process.env.MUSIC_DIR || config.musicDir || join(backendRoot, '..', 'downloadedMusic'));
export const dataDir = join(backendRoot, 'data');
export const python = process.env.PYTHON_BIN || join(backendRoot, '.venv', 'Scripts', 'python.exe');
export const ffmpeg = process.env.FFMPEG_BIN
  || join(backendRoot, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v9.0.2.exe');

// Big, re-downloadable files (separator Python env with PyTorch, AI models, cloned repos) live OUTSIDE the project,
// so OneDrive does not sync gigabytes. Priority: MUSEHIK_HEAVY_DIR env > config.json "heavyDir" > ~/MuseHikData
export const heavyDir = resolve(process.env.MUSEHIK_HEAVY_DIR || config.heavyDir || join(homedir(), 'MuseHikData'));
export const separatorPython = process.env.SEPARATOR_PYTHON || join(heavyDir, 'separator-venv', 'Scripts', 'python.exe');
export const separatorModelsDir = join(heavyDir, 'models');
