// Starts the backend exactly as the installed app does, from a built app's resources folder, and checks it works:
// the page loads, Python + yt-dlp answer, ffmpeg is there, and it quits cleanly. The release build runs this before
// publishing, so an installer that cannot start is never published.   Usage: node scripts/smoke.mjs <resources dir>
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFfmpeg } from '../python.mjs';

const resources = resolve(process.argv[2] || 'dist/win-unpacked/resources');
const port = 38599;
const tmp = mkdtempSync(join(tmpdir(), 'musehik-smoke-'));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

const node = join(resources, 'node', 'node.exe');
const python = join(resources, 'python', 'python.exe');
const ffmpeg = findFfmpeg(join(resources, 'python'));
for (const [name, path] of [['node.exe', node], ['python.exe', python], ['backend/server.mjs', join(resources, 'backend', 'server.mjs')],
  ['backend/node_modules/music-metadata', join(resources, 'backend', 'node_modules', 'music-metadata')],
  ['backend/node_modules/basic-ftp', join(resources, 'backend', 'node_modules', 'basic-ftp')],
  ['web/index.html', join(resources, 'web', 'index.html')], ['python/musehik-python.json', join(resources, 'python', 'musehik-python.json')]]) {
  check(`ships ${name}`, existsSync(path), path);
}
check('ships ffmpeg', Boolean(ffmpeg));

const server = fork(join(resources, 'backend', 'server.mjs'), [], {
  execPath: node, cwd: join(resources, 'backend'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env, PORT: String(port), MUSEHIK_INSTALLED: '1', MUSEHIK_VERSION: 'smoke', MUSEHIK_DATA_DIR: join(tmp, 'data'),
    MUSEHIK_DEFAULT_MUSIC_DIR: join(tmp, 'music'), MUSEHIK_WEB_ROOT: join(resources, 'web'), CLOUD_CACHE_DIR: join(tmp, 'cache'),
    PYTHON_BIN: python, ...(ffmpeg ? { FFMPEG_BIN: ffmpeg } : {}),
  },
});
let output = '';
server.stdout.on('data', d => { output += d; });
server.stderr.on('data', d => { output += d; });

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 120 && server.exitCode === null && !up; i++) {
  try { up = (await fetch(`${base}/api/app`)).ok; } catch { await new Promise(r => setTimeout(r, 500)); }
}
check('the server starts', up, up ? '' : output.slice(-2000));
if (up) {
  const info = await (await fetch(`${base}/api/app`)).json();
  check('it runs as the installed app', info.installed === true && info.profile === 'muttmutt', JSON.stringify(info));
  const page = await (await fetch(base)).text();
  check('the app page is served', page.includes('<title>MuseHik</title>'));
  const engine = await (await fetch(`${base}/api/download/engine`)).json();
  check('Python runs yt-dlp', Boolean(engine.ytdlp), JSON.stringify(engine).slice(0, 300));
  check('the YouTube challenge solver is installed', Boolean(engine.ejs));
  const exited = new Promise(r => server.once('exit', r));
  server.send('quit');
  const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 10000))]);
  check('it quits cleanly', code === 0, String(code));
}
if (server.exitCode === null) server.kill();
console.log(failed ? `\n${failed} smoke check(s) FAILED` : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
