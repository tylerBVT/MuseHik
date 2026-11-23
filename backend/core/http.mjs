// Small HTTP helpers shared by every module's routes.
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/** Reads a small JSON request body (throws above `limit` characters). */
export async function readJson(req, limit = 200000) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > limit) throw new Error('Request too large.');
  }
  return JSON.parse(raw || '{}');
}

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav' };
const typeOf = path => MIME[extname(path).toLowerCase()] || 'application/octet-stream';

/**
 * The bytes a request asks for, out of `size`: { start, end, partial } (`partial`: there was a Range header),
 * or null when the range cannot be served (416).
 */
export function parseRange(header, size) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!range) return { start: 0, end: size - 1, partial: false };
  const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  const end = Math.min(range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]), size - 1);
  return start >= 0 && start <= end ? { start, end, partial: true } : null;
}

/** Status and headers for the bytes `r` of a file of `size` bytes. */
function rangeHead(r, size, type, headers) {
  const head = { ...headers, 'Content-Type': type, 'Content-Length': r.end - r.start + 1, 'Accept-Ranges': 'bytes' };
  if (r.partial) head['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
  return [r.partial ? 206 : 200, head];
}

function refuseRange(res, size, headers) {
  res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
  res.end();
}

/** Serves a file with HTTP Range support, which <audio> needs for seeking. */
export async function streamFile(req, res, path, headers) {
  const { size } = await stat(path);
  const r = parseRange(req.headers.range, size);
  if (!r) return refuseRange(res, size, headers);
  res.writeHead(...rangeHead(r, size, typeOf(path), headers));
  createReadStream(path, { start: r.start, end: r.end }).pipe(res);
}

/**
 * Serves a file that is still being downloaded, so playing starts at once. `source`: { path (the file being
 * written), target (its name once complete), size (final size), written (bytes on disk so far), done, error,
 * changed() (resolves when more bytes landed, or soon anyway) }. A range not downloaded yet waits for its bytes.
 */
export async function streamGrowing(req, res, source, headers) {
  const { size } = source;
  const r = parseRange(req.headers.range, size);
  if (!r) return refuseRange(res, size, headers);
  let file;
  try {
    file = await open(source.path, 'r');
  } catch (e) {
    // Finished (and renamed) between the caller's check and now: serve the complete file.
    if (source.done && source.target) return streamFile(req, res, source.target, headers);
    throw e;
  }
  res.writeHead(...rangeHead(r, size, typeOf(source.target || source.path), headers));
  let gone = false;
  res.once('close', () => { gone = true; });
  // Whichever comes first removes the other listener, so a slow listener never piles them up.
  const drained = () => new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let pos = r.start;
    while (pos <= r.end && !gone) {
      if (source.error) return void res.destroy();
      const until = Math.min(source.written, r.end + 1);
      if (until <= pos) {
        if (source.done) return void res.destroy(); // complete but shorter than announced: cut, never pad
        await source.changed();
        continue;
      }
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, until - pos), pos);
      if (!bytesRead) { await source.changed(); continue; }
      pos += bytesRead;
      if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) await drained();
    }
    if (!gone) res.end();
  } finally {
    await file.close();
  }
}
