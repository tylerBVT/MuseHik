// Dev-only local server. Each module (modules/*/routes.mjs) answers its own part of the /api.
//   musicDownloader: link -> background job -> audio files in the flat music folder
//   musicPlayer:     library list, audio stream, cover art, playlists
//   instrumentalSeparator: library song -> instrumental MP3 (Python + GPU job, one at a time)
//   cloud:           upload songs to / play songs from the LWS hosting over FTP (10 GB/month budget)
// Anything outside /api is the built Angular app (core/static.mjs).
import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { musicDir, python } from './core/config.mjs';
import { scanLibrary } from './core/library.mjs';
import { serveStatic } from './core/static.mjs';
import * as musicDownloader from './modules/musicDownloader/routes.mjs';
import { startAutoUpdates } from './modules/musicDownloader/updater.mjs';
import { moveOldResults } from './modules/instrumentalSeparator/jobs.mjs';
import * as musicPlayer from './modules/musicPlayer/routes.mjs';
import * as instrumentalSeparator from './modules/instrumentalSeparator/routes.mjs';
import * as cloud from './modules/cloud/routes.mjs';
import { startPlaylistSync } from './modules/cloud/playlistSync.mjs';

const port = Number(process.env.PORT || 3000);
// 4200 = Angular dev server (ng serve); 3000 = the built app served by this server (MuseHik.bat).
const allowedOrigins = new Set([
  'http://localhost:4200', 'http://127.0.0.1:4200', `http://localhost:${port}`, `http://127.0.0.1:${port}`,
]);
const modules = [musicDownloader, musicPlayer, instrumentalSeparator, cloud];

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = allowedOrigins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin',
      }
    : {};
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };
  if (origin && !allowedOrigins.has(origin)) return json(403, { error: 'Invalid origin' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    for (const module of modules) if (await module.handle(req, { res, json, cors })) return;
    if (!req.url.startsWith('/api/') && serveStatic(req, res)) return;
    json(404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(400, { error: e.message });
    else res.end();
  }
});

/** Scans the library, then listens. Resolves with the address once the server is up. */
export async function start() {
  if (!existsSync(python)) console.warn(`Python venv missing at ${python}`);
  await moveOldResults().catch(e => console.error('Could not move old instrumentals:', e.message));
  const scan = await scanLibrary();
  console.log(`Library: ${scan.total} tracks (${scan.added} new, ${scan.removed} removed)`);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}`;
  console.log(`Server on ${url}, saving to ${musicDir()}`);
  startAutoUpdates(); // yt-dlp: daily background update check
  startPlaylistSync(); // shared playlists: now, every 5 min, and after each change
  return url;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await start();
