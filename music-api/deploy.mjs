// Deploys this folder to the LWS hosting over FTP (TLS), then checks the live API from outside.
//
//   node music-api/deploy.mjs              check the hosting's PHP, upload, smoke-test
//   node music-api/deploy.mjs --check      only the PHP check and the smoke test (uploads nothing)
//   node music-api/deploy.mjs --new-config write config.php again (a new key: every device must be set up again)
//   node music-api/deploy.mjs --show-key   also print the API key (to type it in Settings on a laptop or the phone)
//
// Credentials live outside the repo, in %USERPROFILE%\MuseHikData\lws-deploy.json (or MUSIC_API_DEPLOY):
//   { host, port, user, password, tlsName, remoteDir, dataFolder, url, apiKey }
// LWS's FTP certificate is *.lwspanel.com, not ftp.<domain>: curl connects to `host` but checks the certificate
// against `tlsName`, so the connection is encrypted and the server proven to be LWS's. Nothing is ever sent in clear.
// config.php is written only when the server has none (or with --new-config), so a redeploy keeps the key.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const here = import.meta.dirname;
const args = new Set(process.argv.slice(2));
const credsFile = process.env.MUSIC_API_DEPLOY || join(homedir(), 'MuseHikData', 'lws-deploy.json');
const d = JSON.parse(readFileSync(credsFile, 'utf8'));
for (const k of ['host', 'user', 'password', 'tlsName', 'remoteDir', 'dataFolder', 'url', 'apiKey']) {
  if (!d[k]) throw new Error(`${credsFile} has no "${k}".`);
}
const port = d.port || 21;
const url = d.url.replace(/\/+$/, '');
const siteRoot = url.slice(0, url.lastIndexOf('/'));
const parentDir = posix.dirname(d.remoteDir);
const tmp = mkdtempSync(join(tmpdir(), 'music-api-deploy-'));
const MAX_UPLOAD_MB = 200;

let failures = 0;
const ok = msg => console.log(`  ok    ${msg}`);
const bad = msg => { failures++; console.log(`  FAIL  ${msg}`); };
const warn = msg => console.log(`  warn  ${msg}`);

/** One curl FTP call. The user and password go through stdin (-K -), never on the command line. */
function ftp(path, extra = []) {
  const r = spawnSync('curl', [
    '-sS', '--max-time', '120', '--ssl-reqd', '--ftp-create-dirs',
    '--connect-to', `${d.tlsName}:${port}:${d.host}:${port}`, '-K', '-', ...extra, `ftp://${d.tlsName}:${port}${path}`,
  ], { input: `user = "${d.user}:${d.password}"\n`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`FTP ${path}: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}
const list = dir => ftp(`${dir}/`, ['--list-only']).split(/\r?\n/).filter(Boolean);
/** Uploads under a temporary name, then renames: a request never runs half a file. */
const put = (local, remote) => ftp(`${remote}.uploading`, ['-T', local, '-Q', `-RNFR ${remote}.uploading`, '-Q', `-RNTO ${remote}`]);
const remove = remote => ftp('/', ['-Q', `DELE ${remote}`, '--list-only']);

async function http(path, { key, method = 'GET', headers = {}, base = url } = {}) {
  const h = { ...headers };
  if (key) h['X-API-Key'] = key;
  // A fresh query on every check: LWS's edge cache must not answer for the server.
  const fresh = `${path}${path.includes('?') ? '&' : '?'}deploycheck=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${base}${fresh}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const bytes = v => { const n = parseInt(v, 10); const u = String(v).trim().slice(-1).toUpperCase(); return n * ({ G: 2 ** 30, M: 2 ** 20, K: 2 ** 10 }[u] ?? 1); };

/** The hosting's PHP, read by a throwaway script that is deleted right after. */
async function checkPhp() {
  console.log('PHP on the hosting');
  const name = `mh-check-${randomBytes(8).toString('hex')}.php`;
  const local = join(tmp, name);
  writeFileSync(local, `<?php header('Content-Type: application/json'); echo json_encode(['php' => PHP_VERSION,
    'mbstring' => extension_loaded('mbstring'), 'intl' => extension_loaded('intl'),
    'upload_max_filesize' => ini_get('upload_max_filesize'), 'post_max_size' => ini_get('post_max_size'),
    'max_execution_time' => ini_get('max_execution_time'), 'memory_limit' => ini_get('memory_limit')]);`);
  put(local, `${parentDir === '/' ? '' : parentDir}/${name}`);
  let info;
  try {
    const res = await http(`/${name}`, { base: siteRoot });
    info = JSON.parse(res.text);
  } catch (e) {
    bad(`could not run a PHP check script (${e.message})`);
    return;
  } finally {
    remove(`${parentDir === '/' ? '' : parentDir}/${name}`);
  }
  const [major, minor] = info.php.split('.').map(Number);
  (major > 8 || (major === 8 && minor >= 1) ? ok : bad)(`PHP ${info.php} (8.1 or newer needed)`);
  (info.mbstring ? ok : bad)('mbstring');
  (info.intl ? ok : warn)(`intl ${info.intl ? '' : 'missing (a slower fallback is used)'}`);
  for (const k of ['upload_max_filesize', 'post_max_size']) {
    (bytes(info[k]) >= MAX_UPLOAD_MB * 2 ** 20 ? ok : warn)(`${k} = ${info[k]} (songs up to ${MAX_UPLOAD_MB} MB)`);
  }
  ok(`max_execution_time = ${info.max_execution_time}, memory_limit = ${info.memory_limit}`);
}

function configPhp() {
  const origins = ['https://localhost', 'http://localhost', 'capacitor://localhost'];
  return `<?php
// Written by deploy.mjs. The cloud folder is next to this API's folder.
return [
    'dataDir' => dirname(__DIR__) . '/${d.dataFolder}',
    'apiKey' => '${d.apiKey}',
    'maxUploadMB' => ${MAX_UPLOAD_MB},
    'storageLimitGB' => 30,
    'defaultAddedBy' => 'phone',
    'allowedOrigins' => ${JSON.stringify(origins).replace(/"/g, "'").replace(/,/g, ', ')},
];
`;
}

function upload() {
  console.log(`Upload to ${d.remoteDir}`);
  const existing = (() => { try { return list(d.remoteDir); } catch { return []; } })();
  // .htaccess first: config.php and lib/ are never reachable, even during a first deploy.
  put(join(here, '.htaccess'), `${d.remoteDir}/.htaccess`);
  ok('.htaccess');
  if (!existing.includes('config.php') || args.has('--new-config')) {
    const local = join(tmp, 'config.php');
    writeFileSync(local, configPhp());
    put(local, `${d.remoteDir}/config.php`);
    ok(existing.includes('config.php') ? 'config.php (new key)' : 'config.php (first deploy)');
  } else ok('config.php kept (same key)');
  for (const f of readdirSync(join(here, 'lib')).filter(f => f.endsWith('.php'))) {
    put(join(here, 'lib', f), `${d.remoteDir}/lib/${f}`);
    ok(`lib/${f}`);
  }
  put(join(here, 'index.php'), `${d.remoteDir}/index.php`);
  ok('index.php');
}

async function smoke() {
  console.log(`Live checks on ${url}`);
  const status = await http('/status', { key: d.apiKey });
  let body = null;
  try { body = JSON.parse(status.text); } catch { /* checked below */ }
  if (status.status === 200 && body && 'storageLimitBytes' in body) {
    ok(`GET /status: ${body.songs} songs, ${(body.storedBytes / 1e9).toFixed(2)} GB of ${body.storageLimitBytes / 1e9} GB`);
  } else bad(`GET /status gave ${status.status}: ${status.text.slice(0, 200)}`);
  const songs = await http('/songs', { key: d.apiKey });
  (songs.status === 200 ? ok : bad)(`GET /songs: ${songs.status}${songs.status === 200 ? `, synced ${JSON.stringify(JSON.parse(songs.text).synced)}` : ''}`);
  const noKey = await http('/status');
  (noKey.status === 401 ? ok : bad)(`no key: ${noKey.status} (401 expected)`);
  const config = await http('/config.php');
  (config.status === 403 && !config.text.includes(d.apiKey) ? ok : bad)(`config.php from the web: ${config.status} (403 expected)`);
  const lib = await http('/lib/store.php');
  (!lib.text.includes('<?php') && lib.status !== 200 ? ok : bad)(`lib/ from the web: ${lib.status}, no source shown`);
  const cloud = await http(`/${d.dataFolder}/library.json`, { base: siteRoot });
  (cloud.status === 403 ? ok : bad)(`/${d.dataFolder}/library.json from the web: ${cloud.status} (403 expected)`);
  // The edge cache: an answer given with the key must never be served again to a request without it.
  const probe = `/status?leakcheck=${Date.now()}`;
  const first = await fetch(`${url}${probe}`, { headers: { 'X-API-Key': d.apiKey } });
  (/no-store/.test(first.headers.get('cache-control') ?? '') ? ok : bad)(`Cache-Control: ${first.headers.get('cache-control')}`);
  await first.arrayBuffer();
  await new Promise(r => setTimeout(r, 1500));
  const second = await fetch(`${url}${probe}`);
  (second.status === 401 ? ok : bad)(`the hosting's cache does not hand out keyed answers (${second.status}, ${second.headers.get('x-cache-status')})`);
  const pre = await http('/songs', { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'GET' } });
  (pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://localhost' ? ok : bad)(`phone preflight: ${pre.status}`);
}

try {
  await checkPhp();
  if (!args.has('--check') && !failures) upload();
  await smoke();
} catch (e) {
  bad(e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed.` : `\nThe music API is live at ${url}`);
if (args.has('--show-key')) console.log(`API key: ${d.apiKey}`);
process.exitCode = failures ? 1 : 0;
