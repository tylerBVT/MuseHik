// New versions of the app: GitHub Releases of tylerBVT/MuseHik (published by .github/workflows/release.yml).
// Checked at start and every 4 hours, downloaded in the background; installed on "Restart now" or when MuseHik closes.
import { appendFileSync } from 'node:fs';
import updater from 'electron-updater';

const { autoUpdater } = updater;
const EVERY = 4 * 3600 * 1000;

/** @param {{ packaged: boolean, send: (channel: string, value: string) => void, logFile: string }} o */
export function startUpdates({ packaged, send, logFile }) {
  let state = { status: 'latest' };
  if (!packaged) return { state: () => state, checkNow: async () => state, install: () => {} };

  const write = level => message => {
    try { appendFileSync(logFile, `[updates ${level}] ${message}\n`); } catch { /* not important */ }
  };
  autoUpdater.logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => { state = { status: 'downloading', version: info.version }; });
  autoUpdater.on('update-not-available', () => { if (state.status !== 'ready') state = { status: 'latest' }; });
  autoUpdater.on('update-downloaded', info => {
    state = { status: 'ready', version: info.version };
    send('update-ready', info.version);
  });
  autoUpdater.on('error', e => {
    if (state.status !== 'ready') state = { status: 'error', message: `Could not check for updates (${e.message.split('\n')[0]}).` };
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // errors arrive through the 'error' event
  void check();
  setInterval(check, EVERY).unref();

  return {
    state: () => state,
    async checkNow() {
      if (state.status === 'ready' || state.status === 'downloading') return state;
      await check();
      return state;
    },
    install: () => autoUpdater.quitAndInstall(false, true),
  };
}
