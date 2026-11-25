// A real cloud for tests: the PHP music API (music-api/, the code that runs on LWS) under `php -S`, on a fresh
// temporary cloud folder (<root>/music), behind a small proxy that counts what the laptop asks for and can make the
// network slow. Not a test file itself (node --test only picks *.test.mjs here).
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { findPhp, startApi } from './php-fixture.mjs';

/** Why cloud tests are skipped on a machine without PHP (false when PHP is there). */
export const noPhp = findPhp() ? false : 'PHP not found (set MUSEHIK_PHP or install it in MuseHikData\\php-8.1)';

/** Sends `data` in `chunk`-byte pieces, `delayMs` apart (a slow internet). */
const drip = ({ chunk, delayMs }) => new Transform({
  transform(data, _enc, done) {
    const pieces = [];
    for (let i = 0; i < data.length; i += chunk) pieces.push(data.subarray(i, i + chunk));
    const next = () => {
      if (!pieces.length) return done();
      this.push(pieces.shift());
      setTimeout(next, delayMs);
    };
    next();
  },
});

/**
 * Starts the cloud. Returns { root, cloudDir, settings, api, setConfig, requests, reads, close }:
 *   settings  ready for the laptop's cloud code ({ url, key, name, cacheLimitGB, online })
 *   requests  how many requests reached the cloud so far
 *   reads     file names of the songs downloaded so far
 * `slow: { pattern, chunk, delayMs }` sends songs whose file name matches slowly. `config`: config.php overrides.
 */
export async function startCloud({ slow = null, config = {}, key = 'test-key-123' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'musehik-cloud-'));
  const cloudDir = join(root, 'music');
  mkdirSync(cloudDir);
  const api = await startApi({ dataDir: cloudDir, key, config });
  const target = new URL(api.base);
  let requests = 0;
  const reads = [];

  const fileOf = id => {
    try {
      return JSON.parse(readFileSync(join(cloudDir, 'library.json'), 'utf8')).songs.find(s => s.id === id)?.file ?? '';
    } catch { return ''; }
  };

  const proxy = http.createServer((req, res) => {
    requests++;
    const song = /^\/songs\/(\d+)\/file(?:\?|$)/.exec(req.url);
    const file = song && req.method === 'GET' ? fileOf(Number(song[1])) : '';
    if (file) reads.push(file);
    const upstream = http.request({
      host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers,
    }, answer => {
      res.writeHead(answer.statusCode, answer.headers);
      if (slow && file && slow.pattern.test(file)) answer.pipe(drip(slow)).pipe(res);
      else answer.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxy.address().port}`;

  return {
    root,
    cloudDir,
    api,
    /** Changes the server's config.php (e.g. { storageLimitGB }) while it runs. */
    setConfig: patch => api.setConfig(patch),
    settings: { url, key, name: '', cacheLimitGB: 2, online: true },
    get requests() { return requests; },
    reads,
    close: async () => {
      proxy.closeAllConnections?.();
      await new Promise(resolve => proxy.close(resolve));
      await api.close();
    },
  };
}
