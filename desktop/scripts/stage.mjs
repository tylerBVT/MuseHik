// Gathers everything the installer carries into desktop/stage/ (see the "extraResources" in package.json):
//   stage/node/node.exe   the Node that runs the backend and solves YouTube challenges for yt-dlp
//   stage/python/         a standalone Python with yt-dlp and imageio-ffmpeg (backend/requirements.txt) installed
//   stage/backend/        the backend code and its production dependencies
//   stage/web/            the built Angular app
// Downloads are pinned and checked against their published SHA-256, and kept in stage/cache/ between runs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The official python.org build (NuGet package "python"), signed by the Python Software Foundation: Windows Smart App
// Control blocks unsigned Python DLLs (it did with python-build-standalone's _ssl.pyd). Hash from nuget.org's catalog.
const PYTHON = {
  url: 'https://api.nuget.org/v3-flatcontainer/python/3.14.10/python.3.14.10.nupkg',
  hash: { algorithm: 'sha512', encoding: 'base64', value: 'fZln2RPYmfZLoVEYVNaczQCatkuZyLHSuhhMhjzmgtHSFP+mlChqyVpVmjr5Wi2o6ZQ3WwK+B0vefqz9kCpTcQ==' },
};
// Node 24 LTS (Krypton), from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
const NODE = {
  url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip',
  hash: { algorithm: 'sha256', encoding: 'hex', value: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f' },
};

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const stage = join(desktop, 'stage');
const cache = join(stage, 'cache');
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows' own tar reads .zip too

function run(command, args, cwd, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error(`${command} failed (${r.status ?? r.error?.message})`);
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const digest = (data, { algorithm, encoding }) => createHash(algorithm).update(data).digest(encoding);

async function download({ url, hash }) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, decodeURIComponent(basename(url)));
  if (existsSync(file) && digest(readFileSync(file), hash) === hash.value) return file;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = digest(data, hash);
  if (actual !== hash.value) throw new Error(`Checksum mismatch for ${url}: ${actual}`);
  writeFileSync(file, data);
  return file;
}

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Newest modification time under `dir` (same rule as backend/launch.mjs). */
function newest(dir) {
  let time = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    time = Math.max(time, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return time;
}

async function stageNode() {
  const zip = await download(NODE);
  const out = fresh(join(cache, 'node-extract'));
  run(tar, ['-xf', zip, '-C', out]);
  const folder = readdirSync(out)[0];
  cpSync(join(out, folder, 'node.exe'), join(fresh(join(stage, 'node')), 'node.exe'));
}

async function stagePython() {
  const archive = await download(PYTHON);
  const out = fresh(join(cache, 'python-extract'));
  run(tar, ['-xf', archive, '-C', out]); // a .nupkg is a zip; Python itself is in tools/
  const python = join(stage, 'python');
  rmSync(python, { recursive: true, force: true });
  cpSync(join(out, 'tools'), python, { recursive: true });
  run(join(python, 'python.exe'), ['-m', 'ensurepip', '--upgrade', '--default-pip'], repo);
  const requirements = join(repo, 'backend', 'requirements.txt');
  run(join(python, 'python.exe'), ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', '-r', requirements], repo);
  // Which bundled build this is: an app update with another id replaces the user's copy (desktop/python.mjs).
  const id = sha256(PYTHON.url + readFileSync(requirements, 'utf8').replace(/\r\n/g, '\n'));
  writeFileSync(join(python, 'musehik-python.json'), JSON.stringify({ id }));
}

function stageBackend() {
  const from = join(repo, 'backend');
  const to = join(stage, 'backend');
  rmSync(to, { recursive: true, force: true });
  const skip = new Set(['tests', 'data', '.venv', 'node_modules', 'config.json', '__pycache__']);
  cpSync(from, to, {
    recursive: true,
    filter: src => !relative(from, src).split(sep).some(part => skip.has(part)) && !src.endsWith('.log'),
  });
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], to, { shell: true });
  if (!existsSync(join(to, 'node_modules', 'music-metadata'))) throw new Error('The backend dependencies were not installed in stage/backend.');
}

function stageWeb() {
  const frontend = join(repo, 'frontend');
  const built = join(frontend, 'dist', 'musehik-frontend', 'browser');
  const index = join(built, 'index.html');
  if (!existsSync(index) || newest(join(frontend, 'src')) > statSync(index).mtimeMs) {
    run('npx', ['ng', 'build'], frontend, { shell: true });
  }
  const to = join(stage, 'web');
  rmSync(to, { recursive: true, force: true });
  cpSync(built, to, { recursive: true });
}

await stageNode();
await stagePython();
stageBackend();
stageWeb();
console.log(`\nStaged in ${stage}`);
