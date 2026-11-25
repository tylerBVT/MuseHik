// Runs the PHP music API on this laptop, exactly as it will run on LWS, for trying it by hand and from the phone:
//   node tests/music-api-dev.mjs          (from backend/; Ctrl+C stops it)
// The "cloud folder" is %USERPROFILE%\MuseHikData\music-api-dev\music. On the first run it is filled with 5 songs
// of your library and one shared playlist, through the laptops' real cloud code (talking to this API), so the
// files are exactly what the laptops write. Your real cloud settings are never touched.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';

const root = join(homedir(), 'MuseHikData', 'music-api-dev');
const cloudDir = join(root, 'music');
mkdirSync(cloudDir, { recursive: true });
// The laptop side writes its settings and cache here, never in backend/data.
process.env.CLOUD_SETTINGS = join(root, 'laptop-cloud.json');
process.env.CLOUD_CACHE_DIR = join(root, 'laptop-cache');

const { startApi, findPhp } = await import('./php-fixture.mjs');
if (!findPhp()) {
  console.error('PHP not found. Install it in %USERPROFILE%\\MuseHikData\\php-8.1 or set MUSEHIK_PHP.');
  process.exit(1);
}

const keyFile = join(root, 'key.txt');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(16).toString('hex'));
const key = readFileSync(keyFile, 'utf8').trim();

const firstRun = !existsSync(join(cloudDir, 'library.json'));
const api = await startApi({ dataDir: cloudDir, key, host: '0.0.0.0', port: Number(process.env.PORT || 8000) });
const port = new URL(api.base).port;
if (firstRun) await seed({ url: api.base, key, name: 'dev seed', cacheLimitGB: 1, online: true });
const addresses = Object.values(networkInterfaces()).flat()
  .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

console.log(`
MuseHik music API running (Ctrl+C to stop)
  Cloud folder : ${cloudDir}
  On this laptop: http://127.0.0.1:${port}
  From the phone: ${addresses.map(a => `http://${a}:${port}`).join('  or  ') || '(no wifi address found)'}
  API key      : ${key}

Try:  curl.exe -H "X-API-Key: ${key}" http://127.0.0.1:${port}/songs
(Windows may ask whether PHP may use the network: allow it on private networks so the phone can connect.)
`);

const stop = async () => { await api.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** First run: 5 songs of the library and a shared playlist, written by the laptops' own cloud code. */
async function seed(settings) {
  const { musicDir } = await import('../core/config.mjs');
  const { parseFile } = await import('music-metadata');
  const { withCloud } = await import('../modules/cloud/store.mjs');

  const dir = musicDir();
  const files = readdirSync(dir).filter(f => extname(f).toLowerCase() === '.mp3').slice(0, 5);
  if (!files.length) {
    console.log(`No .mp3 in ${dir}: the cloud folder starts empty.`);
    return;
  }
  const songs = [];
  for (const file of files) {
      const path = join(dir, file);
      const { common, format } = await parseFile(path);
      const base = file.slice(0, -4);
      const dash = base.indexOf(' - ');
      const title = common.title || (dash > 0 ? base.slice(dash + 3) : base);
      const artist = common.artist || (dash > 0 ? base.slice(0, dash) : '');
    songs.push(await withCloud(cloud => cloud.upload(path, {
      title, artist, album: common.album || '', duration: Math.round(format.duration || 0),
      isrc: common.isrc?.[0] || '', addedBy: 'dev seed',
    }), settings));
    console.log(`Seeded: ${artist} - ${title}`);
  }
  await withCloud(cloud => cloud.putPlaylist({
    uid: 'dev-seed-playlist', name: 'Dev seed', owner: 'dev seed', updatedAt: Date.now(),
    songs: songs.map(({ title, artist, album, duration, isrc, key }) => ({ title, artist, album, duration, isrc, key })),
  }), settings);
}
