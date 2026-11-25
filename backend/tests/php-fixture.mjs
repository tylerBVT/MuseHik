// Runs the PHP music API (music-api/) for tests: finds a PHP binary, runs PHP snippets, and starts `php -S` on a
// data folder with a generated config. Not a test file itself (node --test only picks *.test.mjs here).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const apiDir = resolve(import.meta.dirname, '..', '..', 'music-api');

/** The PHP binary: MUSEHIK_PHP, then the portable one in MuseHikData, then `php` on PATH. Null when none works. */
export function findPhp() {
  const candidates = [process.env.MUSEHIK_PHP, join(homedir(), 'MuseHikData', 'php-8.1', 'php.exe'), 'php'].filter(Boolean);
  for (const php of candidates) {
    if (php !== 'php' && !existsSync(php)) continue;
    try {
      execFileSync(php, ['-n', '-v'], { stdio: 'ignore' });
      return php;
    } catch { /* next */ }
  }
  return null;
}

const php = findPhp();

/**
 * Command-line options: no php.ini (-n, so the machine's settings never change a result), then exactly the
 * extensions the API may rely on. `intl: false` checks the fallback used when a hosting lacks intl.
 */
export function phpArgs({ intl = true } = {}) {
  const ext = join(dirname(php), 'ext');
  const args = ['-n', '-d', `extension_dir=${ext}`, '-d', 'extension=mbstring', '-d', 'extension=fileinfo'];
  if (intl) args.push('-d', 'extension=intl');
  args.push('-d', 'upload_max_filesize=200M', '-d', 'post_max_size=210M', '-d', 'display_errors=stderr');
  // PHP 8.5 always has opcache, which would keep a config.php changed by setConfig() for a few seconds.
  args.push('-d', 'opcache.enable=0');
  return args;
}

/** Runs a PHP snippet (no <?php tag) and returns what it printed. */
export function runPhp(code, { intl = true } = {}) {
  return execFileSync(php, [...phpArgs({ intl }), '-r', code], { encoding: 'utf8', cwd: apiDir });
}

const freePort = () => new Promise((ok, ko) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => ok(port));
  }).on('error', ko);
});

const phpString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const phpValue = v => (Array.isArray(v) ? `[${v.map(phpValue).join(', ')}]`
  : typeof v === 'string' ? phpString(v) : JSON.stringify(v));

/** Writes a config.php for the API and returns its path. */
export function writeConfig(config, dir = mkdtempSync(join(tmpdir(), 'music-api-config-'))) {
  const file = join(dir, 'config.php');
  const lines = Object.entries(config).map(([k, v]) => `  ${phpString(k)} => ${phpValue(v)},`);
  writeFileSync(file, `<?php\nreturn [\n${lines.join('\n')}\n];\n`);
  return file;
}

/**
 * Starts `php -S` on the API with `dataDir` as the cloud folder. Returns { base, key, call, close }.
 * `call(method, path, { body, headers, key, query })`: `key: null` sends no key; a plain object body is sent as JSON.
 */
export async function startApi({ dataDir, key = 'test-key', intl = true, config = {}, host = '127.0.0.1', port } = {}) {
  port ??= await freePort();
  let settings = {
    dataDir, apiKey: key, maxUploadMB: 200, storageLimitGB: 30, defaultAddedBy: 'phone',
    allowedOrigins: ['https://localhost', 'http://localhost', 'capacitor://localhost', 'http://localhost:4200'],
    ...config,
  };
  const configFile = writeConfig(settings);
  const child = spawn(php, [...phpArgs({ intl }), '-S', `${host}:${port}`, 'router.php'], {
    cwd: apiDir, env: { ...process.env, MUSIC_API_CONFIG: configFile }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (i > 50 || child.exitCode !== null) throw new Error(`php -S did not start:\n${log}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const call = (method, path, { body, headers = {}, key: given = key, query = '' } = {}) => {
    const h = { ...headers };
    if (given !== null) h['X-API-Key'] = given;
    let payload = body;
    if (body && !(body instanceof FormData) && typeof body === 'object') {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    return fetch(`${base}${path}${query}`, { method, headers: h, body: payload });
  };
  return {
    base, key, call, configFile,
    /** Changes config.php while the API runs (PHP reads it on every request). */
    setConfig: patch => { settings = { ...settings, ...patch }; writeConfig(settings, dirname(configFile)); },
    get log() { return log; },
    close: () => new Promise(r => { child.once('exit', r); child.kill(); }),
  };
}

export { php };
