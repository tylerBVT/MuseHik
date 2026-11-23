// App-wide settings: who uses this laptop (profile) and where the music is.
//   GET /api/app, PUT /api/app/profile {profile}, POST /api/app/music-folder/pick, POST /api/app/music-folder {path, move}
import { installed, musicDir, profile, saveAppSettings } from '../../core/config.mjs';
import { readJson } from '../../core/http.mjs';
import { listTracks } from '../../core/library.mjs';
import { pickFolder } from '../../core/pickFolder.mjs';
import { changeMusicDir, FolderError } from './musicFolder.mjs';

const info = () => ({
  profile: profile(), musicDir: musicDir(), songs: listTracks().length, installed,
  version: process.env.MUSEHIK_VERSION || null,
});

/** Handles the request if it belongs to this module; returns true when it did. */
export async function handle(req, { json }) {
  const { method, url } = req;
  if (method === 'GET' && url === '/api/app') { json(200, info()); return true; }
  if (method === 'PUT' && url === '/api/app/profile') {
    const { profile: chosen } = await readJson(req, 1000);
    saveAppSettings({ profile: chosen }); // throws for an unknown profile: the server answers 400
    json(200, info());
    return true;
  }
  if (method === 'POST' && url === '/api/app/music-folder/pick') {
    json(200, { path: await pickFolder('Choose the folder where MuseHik keeps your music') });
    return true;
  }
  if (method === 'POST' && url === '/api/app/music-folder') {
    const { path, move } = await readJson(req, 5000);
    try {
      json(200, await changeMusicDir(path, { move: Boolean(move) }));
    } catch (e) {
      if (!(e instanceof FolderError)) throw e;
      json(e.status, { error: e.message });
    }
    return true;
  }
  return false;
}
