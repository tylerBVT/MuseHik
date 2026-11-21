// One FTP(S) connection to the cloud, confined to the configured folder (the hosting also holds websites: MuseHik
// must never touch anything outside its folder). Every byte that crosses the network is counted in `bytes`,
// so the caller can add it to the monthly traffic counter.
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';

const TIMEOUT_MS = 30000;
const tlsWorks = new Map(); // "host:port" -> false once a TLS attempt failed while plain FTP is allowed

/** A path inside the cloud folder ("library.json", "songs/A - B.mp3"); throws for anything that could leave it. */
export function safeName(name) {
  const text = String(name ?? '');
  const parts = text.split('/');
  if (!text || text.includes('\\') || text.includes(':') || text.startsWith('/')
    || parts.some(p => !p || p === '.' || p === '..')) throw new Error(`Cloud: the path "${text}" is not allowed.`);
  return text;
}

/** Rewrites an FTP/network error as a plain sentence, with the password scrubbed out. */
function plainError(e, settings) {
  const code = e?.code;
  let message;
  if (code === 530) message = 'wrong user name or password.';
  else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    message = `cannot reach ${settings.host}. Check the host name and your internet connection.`;
  else if (code === 'ETIMEDOUT' || /timeout/i.test(e?.message)) message = `${settings.host} did not answer in time.`;
  else message = e?.message || String(e);
  if (settings.password) message = message.split(settings.password).join('***');
  const error = new Error(`Cloud: ${message}`);
  error.code = code;
  return error;
}

/** "No such file": 550 on most servers; some answer 450/451/551 with the reason in words. */
const isMissing = e => e?.code === 550 || /no such file|not found|ENOENT|does not exist/i.test(e?.message ?? '');

const isTlsRefusal = e => typeof e?.code === 'number' && e.code !== 530 && e.code >= 500 // AUTH TLS refused
  || /tls|ssl|certificate|handshake|secure/i.test(e?.message ?? '');

async function connect(settings, secure) {
  const client = new Client(TIMEOUT_MS);
  try {
    await client.access({
      host: settings.host, port: settings.port || 21, user: settings.user, password: settings.password,
      secure, secureOptions: secure ? { servername: settings.host } : undefined,
    });
    return client;
  } catch (e) {
    client.close();
    throw e;
  }
}

/** Connects with FTPS, falling back to plain FTP only when `allowPlainFtp` is set. */
async function connectBest(settings) {
  const key = `${settings.host}:${settings.port}`;
  if (!(settings.allowPlainFtp && tlsWorks.get(key) === false)) {
    try {
      return { client: await connect(settings, true), secure: true };
    } catch (e) {
      if (!isTlsRefusal(e) || !settings.allowPlainFtp) throw e;
      tlsWorks.set(key, false);
    }
  }
  return { client: await connect(settings, false), secure: false };
}

/** Opens a session. Creates the cloud folder if it does not exist yet. Always `close()` it. */
export async function openSession(settings) {
  let client, secure;
  try {
    ({ client, secure } = await connectBest(settings));
    await client.ensureDir(settings.folder);
  } catch (e) {
    client?.close();
    throw plainError(e, settings);
  }
  const root = await client.pwd();
  const at = name => posix.join(root, safeName(name));
  let onBytes = null;
  client.trackProgress(info => {
    session.bytes = info.bytesOverall;
    onBytes?.(info.bytes);
  });

  // basic-ftp does one thing at a time per connection: queue every call.
  let queue = Promise.resolve();
  const run = (work) => {
    const next = queue.then(async () => {
      try { return await work(); } catch (e) { throw e.message?.startsWith('Cloud: ') ? e : plainError(e, settings); }
    });
    queue = next.catch(() => {});
    return next;
  };
  const withSignal = async (signal, work) => {
    if (signal?.aborted) throw new Error('Cloud: stopped.');
    const abort = () => client.close();
    signal?.addEventListener('abort', abort, { once: true });
    try { return await work(); } catch (e) {
      if (signal?.aborted) throw new Error('Cloud: stopped.');
      throw e;
    } finally { signal?.removeEventListener('abort', abort); }
  };
  const ensureParent = async (path) => {
    const dir = posix.dirname(path);
    if (dir !== root) { await client.ensureDir(dir); await client.cd(root); }
  };

  const session = {
    secure,
    bytes: 0,
    readJson: name => run(async () => {
      const path = at(name);
      const chunks = [];
      const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
      try {
        await client.downloadTo(sink, path);
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }),
    writeJson: (name, data) => run(async () => {
      const path = at(name);
      await ensureParent(path);
      await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify(data))]), path);
    }),
    upload: (localPath, name, { signal, onBytes: progress } = {}) => run(async () => {
      const path = at(name);
      await ensureParent(path);
      onBytes = progress ?? null;
      try { await withSignal(signal, () => client.uploadFrom(localPath, path)); } finally { onBytes = null; }
    }),
    download: (name, localPath, { signal } = {}) => run(() => withSignal(signal, () => client.downloadTo(localPath, at(name)))),
    remove: name => run(() => client.remove(at(name))),
    rename: (from, to) => run(() => client.rename(at(from), at(to))),
    list: subdir => run(async () => {
      try {
        const entries = await client.list(at(subdir));
        return entries.filter(e => e.isFile).map(e => ({ name: e.name, size: e.size }));
      } catch (e) {
        if (isMissing(e)) return [];
        throw e;
      }
    }),
    close: async () => { await queue; client.close(); },
  };
  return session;
}

/** For the "Test connection" button: can we connect, and is it encrypted? */
export async function testConnection(settings) {
  try {
    const session = await openSession(settings);
    const { secure } = session;
    await session.close();
    return { ok: true, secure };
  } catch (e) {
    if (!settings.allowPlainFtp) {
      try {
        const session = await openSession({ ...settings, allowPlainFtp: true });
        const { secure } = session;
        await session.close();
        if (!secure) {
          return {
            ok: false,
            error: 'This server works only without encryption (plain FTP). Tick "Allow unencrypted FTP" to use it anyway.',
          };
        }
      } catch { /* the first error is the useful one */ }
    }
    return { ok: false, error: e.message };
  }
}
