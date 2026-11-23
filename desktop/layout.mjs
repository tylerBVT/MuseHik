// Where the desktop app finds its parts and keeps the user's data.
//   Installed (packaged): everything comes from resources/ (read-only); data goes to %APPDATA% and %LOCALAPPDATA%.
//   Dev (`npm start` here): the repo's backend, built Angular app, Python venv and data, like MuseHik.bat.
import { join } from 'node:path';

/** Fixed, so the app's origin (and what it keeps in localStorage, like the theme) is the same at every start. */
export const PORT = 38517;

/**
 * @param {{ packaged: boolean, resourcesPath: string, repoRoot: string, appData: string, localAppData: string,
 *   music: string, version: string, devNode: string }} o
 */
export function layout(o) {
  const env = { PORT: String(PORT), MUSEHIK_VERSION: o.version };
  if (!o.packaged) {
    return {
      node: o.devNode, backendDir: join(o.repoRoot, 'backend'), pythonTemplate: null, pythonDir: null,
      logFile: join(o.repoRoot, 'desktop', 'server.log'), env,
    };
  }
  const local = join(o.localAppData, 'MuseHik');
  const pythonDir = join(local, 'python');
  return {
    node: join(o.resourcesPath, 'node', 'node.exe'),
    backendDir: join(o.resourcesPath, 'backend'),
    pythonTemplate: join(o.resourcesPath, 'python'),
    pythonDir,
    logFile: join(local, 'logs', 'server.log'),
    env: {
      ...env,
      MUSEHIK_INSTALLED: '1',
      MUSEHIK_DATA_DIR: join(o.appData, 'MuseHik'),
      MUSEHIK_DEFAULT_MUSIC_DIR: join(o.music, 'MuseHik'),
      MUSEHIK_WEB_ROOT: join(o.resourcesPath, 'web'),
      CLOUD_CACHE_DIR: join(local, 'cloudCache'),
      PYTHON_BIN: join(pythonDir, 'python.exe'),
    },
  };
}
