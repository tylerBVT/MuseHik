// What MuseHik.bat runs: installs what is missing, rebuilds the Angular app if its code changed,
// starts the server and opens the app in the browser. Closing the window stops the server.
// If the server is already running, it only opens the browser.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backendRoot } from './core/config.mjs';
import { webRoot } from './core/static.mjs';

const port = Number(process.env.PORT || 3000);
const url = `http://127.0.0.1:${port}`;
const frontend = join(backendRoot, '..', 'frontend');

function openBrowser() {
  if (process.argv.includes('--no-browser')) return console.log(`(not opening the browser) ${url}`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function run(label, command, cwd) {
  console.log(`\n> ${label}...`);
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`${label} failed (see above).`);
}

/** Newest modification time of the files that make up the app. */
function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(full) : statSync(full).mtimeMs);
  }
  return newest;
}

// 1. Already running? Just open it.
try {
  const r = await fetch(`${url}/api/library`, { signal: AbortSignal.timeout(1500) });
  if (r.ok) {
    console.log(`MuseHik is already running at ${url}. Opening it.`);
    openBrowser();
    process.exit(0);
  }
} catch { /* not running: start it below */ }

// 2. Dependencies (first run only).
if (!existsSync(join(backendRoot, 'node_modules'))) run('Installing server dependencies', 'npm install', backendRoot);
if (!existsSync(join(frontend, 'node_modules'))) run('Installing app dependencies', 'npm install', frontend);

// 3. Rebuild the app only when its code is newer than the last build.
const builtAt = existsSync(join(webRoot, 'index.html')) ? statSync(join(webRoot, 'index.html')).mtimeMs : 0;
const changedAt = Math.max(
  newestSource(join(frontend, 'src')),
  ...['angular.json', 'package.json', 'tsconfig.json', 'tsconfig.app.json'].map(f => statSync(join(frontend, f)).mtimeMs),
);
if (changedAt > builtAt) run('Building the app (only when its code changed)', 'npx ng build', frontend);

// 4. Start the server and open the browser.
const { start } = await import('./server.mjs');
await start();
openBrowser();
console.log('\nMuseHik is running. Keep this window open; close it to stop MuseHik.');
