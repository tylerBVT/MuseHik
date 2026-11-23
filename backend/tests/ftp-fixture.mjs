// A real FTP server on 127.0.0.1 for tests (ftp-srv), serving a fresh temporary folder.
// Not a test file itself (node --test only picks *.test.mjs here).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Transform } from 'node:stream';
import FtpSrv, { FileSystem } from 'ftp-srv';
import { closeLanes } from '../modules/cloud/connections.mjs';

let servers = 0;
const quiet = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  }).on('error', reject);
});

/**
 * Counts the files sent (`reads`), and sends files whose name matches `slow.pattern` in `slow.chunk`-byte pieces,
 * `slow.delayMs` apart (a slow internet).
 */
class TestFs extends FileSystem {
  constructor(connection, options, slow, onRead) {
    super(connection, options);
    this.slow = slow;
    this.onRead = onRead;
  }
  read(fileName, options) {
    this.onRead(fileName);
    return super.read(fileName, options).then(result => {
      if (!this.slow?.pattern.test(fileName)) return result;
      const { chunk, delayMs } = this.slow;
      const drip = new Transform({
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
      return { ...result, stream: result.stream.pipe(drip) };
    });
  }
}

/**
 * Starts the server. Returns { root, settings, logins, reads, dropConnections, close }. `settings` is ready for
 * openSession (plain FTP allowed). `logins` counts successful logins (one per connection opened), `reads` the files
 * sent (downloads).
 */
export async function startFtp({ user = 'test', password = 'secret', slow = null } = {}) {
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
  let logins = 0;
  const reads = [];
  server.on('login', ({ connection, username, password: given }, resolve, reject) => {
    if (username !== user || given !== password) return reject(new Error('Bad login'));
    logins++;
    resolve({ root, fs: new TestFs(connection, { root, cwd: '/' }, slow, name => reads.push(name)) });
  });
  server.on('client-error', () => {});
  await server.listen();
  return {
    root,
    settings: {
      host: '127.0.0.1', port, user, password, folder: 'music',
      storageLimitGB: 30, cacheLimitGB: 2, allowPlainFtp: true,
    },
    get logins() { return logins; },
    /** Names of the files downloaded from the server so far (JSON files included). */
    reads,
    /** The server hangs up on every client (like a hosting that drops idle connections). */
    dropConnections: () => { for (const c of Object.values(server.connections)) c.close(); },
    close: async () => {
      await closeLanes();
      await server.close().catch(() => {});
    },
  };
}
