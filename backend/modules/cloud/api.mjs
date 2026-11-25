// The laptop's way into the cloud: HTTPS calls to the music API (music-api/ on the hosting), with the key from
// Settings. Every failure becomes a CloudError whose message starts with "Cloud: " and reads as a plain sentence.
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename } from 'node:path';

const TIMEOUT_MS = 30_000;

/** A cloud failure. `status`: the server's HTTP status (0 when it was not reached). `song`: the twin on a 409. */
export class CloudError extends Error {
  constructor(message, { status = 0, song = null } = {}) {
    super(`Cloud: ${message}`);
    this.status = status;
    this.song = song;
  }
}

export const baseUrl = settings => String(settings.url ?? '').replace(/\/+$/, '');
const hostOf = settings => { try { return new URL(baseUrl(settings)).host; } catch { return String(settings.url); } };

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

/** A network failure (no answer from the server) as a CloudError. */
function networkError(e, settings) {
  const cause = e?.cause ?? e;
  const code = String(cause?.code ?? '');
  const host = hostOf(settings);
  if (e?.name === 'TimeoutError' || cause?.name === 'TimeoutError' || /TIMEOUT/.test(code)) {
    return new CloudError(`${host} did not answer in time.`);
  }
  if (e?.name === 'AbortError' || cause?.name === 'AbortError') return new CloudError('stopped.');
  if (UNREACHABLE.has(code)) return new CloudError(`cannot reach ${host}. Check the address and your internet connection.`);
  if (/CERT|TLS|SSL/.test(code)) return new CloudError(`the security certificate of ${host} is not valid (${cause.message}).`);
  return new CloudError(cause?.message || String(e));
}

/** An answer that is not a success, as a CloudError (the server's own sentence when it sent one). */
function answerError(status, body, settings) {
  if (status === 401) return new CloudError('wrong key. Check the cloud key in Settings.', { status });
  if (typeof body?.error === 'string') return new CloudError(body.error, { status, song: body.song ?? null });
  if (status === 404) return new CloudError(`no music API at ${baseUrl(settings)}. Check the cloud address in Settings.`, { status });
  return new CloudError(`the server answered with an error (${status}).`, { status });
}

const notTheApi = settings => new CloudError(`${hostOf(settings)} does not answer like the music API. Check the cloud address in Settings.`);

/** A JSON call: returns the parsed answer (null for "204 No Content"). Throws a CloudError. */
export async function apiCall(settings, method, path, { body, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let res;
  try {
    res = await fetch(`${baseUrl(settings)}${path}`, {
      method,
      headers: { 'X-API-Key': settings.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw networkError(e, settings);
  }
  let data = null;
  const text = await res.text().catch(() => '');
  if (text) { try { data = JSON.parse(text); } catch { data = undefined; } }
  if (!res.ok) throw answerError(res.status, data, settings);
  if (res.status === 204) return null;
  if (data === undefined || data === null) throw notTheApi(settings);
  return data;
}

/**
 * Starts reading a song's file. Returns { size (exact, 0 if the server did not say), body (a web ReadableStream) }.
 * Only the wait for the answer times out: the download itself may take as long as it needs.
 */
export async function openFile(settings, id, { signal } = {}) {
  const waiting = new AbortController();
  const timer = setTimeout(() => waiting.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl(settings)}/songs/${id}/file`, {
      headers: { 'X-API-Key': settings.key },
      signal: signal ? AbortSignal.any([waiting.signal, signal]) : waiting.signal,
    });
  } catch (e) {
    throw networkError(waiting.signal.aborted ? waiting.signal.reason : e, settings);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    throw answerError(res.status, data, settings);
  }
  return { size: Number(res.headers.get('content-length')) || 0, body: res.body };
}

/** A form field value on one line (titles never hold line breaks; a stray one must not break the form). */
const oneLine = value => String(value).replace(/[\r\n]+/g, ' ');

/**
 * Uploads one audio file with its details (title, artist, album, duration, isrc, addedBy). Returns the cloud's new
 * entry. A song the cloud already has → CloudError status 409 with `song`; no room → 413. `onBytes(sent)` follows
 * the progress; `signal` stops it (the server then keeps nothing). The exact size is sent up front: some hostings
 * refuse uploads without it.
 */
export function uploadFile(settings, filePath, fields, { signal, onBytes } = {}) {
  const boundary = `----MuseHik${randomBytes(12).toString('hex')}`;
  let head = '';
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${oneLine(value)}\r\n`;
  }
  const fileName = basename(filePath).replace(/["\\\r\n]/g, '_');
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n';
  const headBytes = Buffer.from(head, 'utf8');
  const tailBytes = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = statSync(filePath).size;
  const url = new URL(`${baseUrl(settings)}/songs`);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CloudError('stopped.')); return; }
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'X-API-Key': settings.key,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': headBytes.length + size + tailBytes.length,
      },
    });
    const file = createReadStream(filePath);
    const stop = () => { file.destroy(); req.destroy(new CloudError('stopped.')); };
    signal?.addEventListener('abort', stop, { once: true });
    const finish = () => signal?.removeEventListener('abort', stop);
    // No answer for 2 minutes: the connection is dead (an upload in progress keeps it alive).
    req.setTimeout(120_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', e => {
      finish();
      file.destroy();
      reject(e instanceof CloudError ? e : networkError(e, settings));
    });
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', e => { finish(); reject(networkError(e, settings)); });
      res.on('end', () => {
        finish();
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = undefined; }
        if (res.statusCode >= 300) reject(answerError(res.statusCode, data, settings));
        else if (!data) reject(notTheApi(settings));
        else resolve(data);
      });
    });

    req.write(headBytes);
    let sent = 0;
    file.on('data', chunk => {
      sent += chunk.length;
      onBytes?.(sent);
      if (!req.write(chunk)) {
        file.pause();
        req.once('drain', () => file.resume());
      }
    });
    file.on('end', () => req.end(tailBytes));
    file.on('error', e => req.destroy(e));
  });
}

/** Settings → "Save and test": reaches the API with the key. Never throws. */
export async function testConnection(settings) {
  if (!settings.url || !settings.key) return { ok: false, error: 'Fill in the cloud address and the key first.' };
  try {
    await apiCall(settings, 'GET', '/status', { timeoutMs: 15_000 });
    return { ok: true, secure: baseUrl(settings).startsWith('https:') };
  } catch (e) {
    return { ok: false, error: e.message.replace(/^Cloud: /, '') };
  }
}
