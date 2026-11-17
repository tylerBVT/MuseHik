// Serves the built Angular app (frontend/dist) so the whole app runs from one address: http://127.0.0.1:3000
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { backendRoot } from './config.mjs';

export const webRoot = join(backendRoot, '..', 'frontend', 'dist', 'musehik-frontend', 'browser');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

/** Serves a file of the built app; unknown paths get index.html (the app handles its own pages). */
export function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!existsSync(webRoot)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('The app is not built yet. Run MuseHik.bat, or "npx ng build" in frontend/.');
    return true;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(webRoot, urlPath));
  if (!file.startsWith(webRoot + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(webRoot, 'index.html');
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  // Built files have a hash in their name, so they can be cached; index.html must always be fresh.
  const cache = file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
