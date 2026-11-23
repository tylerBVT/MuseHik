// A real FTP server on 127.0.0.1 for tests (ftp-srv), serving a fresh temporary folder.
// Not a test file itself (node --test only picks *.test.mjs here).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import FtpSrv from 'ftp-srv';

let servers = 0;
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
  // Data-connection ports: a window per test process, below Windows' range for outgoing connections (49152+).
  // ftp-srv checks a port is free, closes it, then opens it again; inside the outgoing range another socket can
  // take it in between, and the client then waits 30 s for nothing (seen when test files run in parallel).
  // 50 ports each: ftp-srv walks the window and gives up after 5 busy ports in a row, so a narrow one stalls.
  const pasvMin = 20000 + (process.pid % 250) * 100 + (servers++ % 2) * 50;
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: pasvMin, pasv_max: pasvMin + 49,
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
      storageLimitGB: 30, cacheLimitGB: 2, allowPlainFtp: true,
    },
    close: () => server.close().catch(() => {}),
  };
}
