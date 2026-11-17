// Small HTTP helpers shared by every module's routes.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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

/** Serves a file with HTTP Range support, which <audio> needs for seeking. */
export async function streamFile(req, res, path, headers) {
  const { size } = await stat(path);
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return createReadStream(path).pipe(res);
  }
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
  end = Math.min(end, size - 1);
  if (!(start >= 0) || start > end) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...headers, 'Content-Type': type, 'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
  });
  createReadStream(path, { start, end }).pipe(res);
}
