// MuseHik as a Windows app: starts the backend (backend/server.mjs) with its own Node, then shows the app in a window.
// Closing the window stops the backend (and its downloads) and quits.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, PORT } from './layout.mjs';
import { ensurePython, findFfmpeg, needsCopy } from './python.mjs';
import { startUpdates } from './updates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = `http://127.0.0.1:${PORT}`;
const windowFile = () => join(app.getPath('userData'), 'window.json');

let win = null;
let backend = null;
let backendStopped = false;
let updates = null;
const lastLines = [];

if (!app.requestSingleInstanceLock()) app.quit(); // MuseHik is already open: that one gets focused
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

function savedBounds() {
  try {
    return JSON.parse(readFileSync(windowFile(), 'utf8'));
  } catch {
    return { width: 1200, height: 850 };
  }
}

function createWindow() {
  const bounds = savedBounds();
  const icon = join(here, 'build', 'icon.png');
  win = new BrowserWindow({
    ...bounds, minWidth: 420, minHeight: 500, title: 'MuseHik', show: false, backgroundColor: '#0f1117',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: { preload: join(here, 'preload.cjs') },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    try {
      writeFileSync(windowFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch { /* not important */ }
  });
  // Links to other sites open in the normal browser, never inside MuseHik.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl) && !url.startsWith('file:')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

const showMessage = query => win?.loadFile(join(here, 'loading.html'), { query });

function startBackend(l, logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  log.write(`\n=== MuseHik ${app.getVersion()} starting ${new Date().toISOString()} ===\n`);
  const child = spawn(l.node, [join(l.backendDir, 'server.mjs')], {
    cwd: l.backendDir, env: { ...process.env, ...l.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const keep = chunk => {
    log.write(chunk);
    lastLines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    lastLines.splice(0, Math.max(0, lastLines.length - 20));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', e => keep(`Could not start the server: ${e.message}\n`));
  child.on('exit', code => {
    log.write(`=== server exited (${code}) ===\n`);
    if (!backendStopped) showError(logFile);
  });
  return child;
}

function showError(logFile) {
  const busy = lastLines.some(line => line.includes('EADDRINUSE'));
  void showMessage({
    error: busy
      ? `MuseHik could not start: port ${PORT} is in use. Close the other MuseHik and try again.`
      : 'MuseHik could not start.',
    details: lastLines.join('\n'),
    log: logFile,
  });
}

/** Resolves once the server answers; false if it stopped first. */
async function waitForBackend(child) {
  const started = Date.now();
  let slowShown = false;
  while (child.exitCode === null) {
    try {
      const r = await fetch(`${appUrl}/api/app`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (!slowShown && Date.now() - started > 20000) {
      slowShown = true;
      void showMessage({ text: 'Reading your music library...' });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/** Asks the backend to stop (it ends its downloads), then makes sure no process is left. */
async function stopBackend() {
  backendStopped = true;
  const child = backend;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { child.send('quit'); } catch { /* channel already closed */ }
  const timedOut = await Promise.race([exited.then(() => false), new Promise(r => setTimeout(() => r(true), 5000))]);
  if (timedOut || child.exitCode === null) {
    await new Promise(resolve => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('exit', resolve));
  }
}

async function start() {
  Menu.setApplicationMenu(null);
  const l = layout({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: join(here, '..'),
    appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA || app.getPath('appData'),
    music: app.getPath('music'), version: app.getVersion(), devNode: process.env.npm_node_execpath || 'node',
  });
  createWindow();
  const firstStart = l.pythonTemplate && needsCopy(l.pythonTemplate, l.pythonDir);
  await showMessage({ text: firstStart ? 'Setting up MuseHik (first start only)...' : 'Starting MuseHik...' });
  if (l.pythonTemplate) {
    try {
      await ensurePython(l.pythonTemplate, l.pythonDir);
    } catch (e) {
      lastLines.push(`Could not set up Python: ${e.message}`);
      return showError(l.logFile);
    }
    const ffmpeg = findFfmpeg(l.pythonDir);
    if (ffmpeg) l.env.FFMPEG_BIN = ffmpeg;
  }
  backend = startBackend(l, l.logFile);
  if (await waitForBackend(backend)) await win.loadURL(appUrl);
  updates = startUpdates({ packaged: app.isPackaged, send: (channel, value) => win?.webContents.send(channel, value), logFile: l.logFile });
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the folder where MuseHik keeps your music', properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle('check-updates', () => updates?.checkNow() ?? { status: 'latest' });
ipcMain.handle('update-state', () => updates?.state() ?? { status: 'latest' });
ipcMain.on('restart-to-update', async () => {
  await stopBackend();
  updates?.install();
});

app.on('before-quit', event => {
  if (backendStopped || !backend || backend.exitCode !== null) return;
  event.preventDefault();
  void stopBackend().then(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.whenReady().then(start);
