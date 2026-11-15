// Deezer service: metadata only, from Deezer's public API (no login for public content).
// Audio is matched on YouTube later, like for Spotify.
const API = 'https://api.deezer.com';

const mapTrack = (t, number, fallbackAlbum = '') => ({
  title: t.title,
  artist: t.artist?.name || '',
  duration: t.duration || 0,
  number,
  album: t.album?.title || fallbackAlbum,
});

/** Builds { name, type, tracks[] } from Deezer API payloads. */
export function mapDeezer(type, data, trackList = data.tracks?.data || []) {
  if (type === 'track') return { name: data.title, type, tracks: [mapTrack(data, 1)] };
  const album = type === 'album' ? data.title : '';
  const tracks = trackList.filter(t => t?.title).map((t, i) => mapTrack(t, i + 1, album));
  return { name: data.title, type, tracks };
}

async function api(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Deezer returned HTTP ${res.status}.`);
  const body = await res.json();
  if (body.error) throw new Error(`Deezer: ${body.error.message || 'link not found or not public'}.`);
  return body;
}

export const deezer = {
  id: 'deezer',
  label: 'Deezer',

  parse(u) {
    if (!/(^|\.)deezer\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album|track)\/(\d+)\/?$/);
    if (!m) throw new Error('Use a Deezer track, album or playlist link.');
    return { type: m[1], id: m[2] };
  },

  async resolve({ type, id }) {
    const data = await api(`/${type}/${id}`);
    let list = [];
    if (type !== 'track') {
      // Page through the tracks so big playlists are complete.
      for (let index = 0; ; index += 100) {
        const page = await api(`/${type}/${id}/tracks?limit=100&index=${index}`);
        list.push(...(page.data || []));
        if (!page.next || index > 5000) break;
      }
    }
    const collection = mapDeezer(type, data, list);
    if (!collection.tracks.length) throw new Error('No tracks found in this Deezer link.');
    return collection;
  },
};
