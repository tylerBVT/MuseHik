// A real FTP server on 127.0.0.1 for tests (ftp-srv), serving a fresh temporary folder.
// Not a test file itself (node --test only picks *.test.mjs here).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import FtpSrv from 'ftp-srv';

const quiet = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  }).on('error', reject);
});

/** Starts the server. Returns { root, settings, close }. `settings` is ready for openSession (plain FTP allowed). */
export async function startFtp({ user = 'test', password = 'secret' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'musehik-ftp-'));
  const port = await freePort();
  const pasvMin = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: pasvMin, pasv_max: pasvMin + 50,
    anonymous: false, log: quiet,
  });
  server.on('login', ({ username, password: given }, resolve, reject) => {
    if (username === user && given === password) resolve({ root });
    else reject(new Error('Bad login'));
  });
  server.on('client-error', () => {});
  await server.listen();
  return {
    root,
    settings: {
      host: '127.0.0.1', port, user, password, folder: 'music',
      monthlyLimitGB: 10, storageLimitGB: 30, cacheLimitGB: 2, allowPlainFtp: true,
    },
    close: () => server.close().catch(() => {}),
  };
}
