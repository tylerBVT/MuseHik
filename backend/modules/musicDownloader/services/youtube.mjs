// YouTube service: the link already is the audio source, so no search is needed.
// Supports single videos and playlists (not auto-generated "Mix" lists, which depend on a seed video).
import { ytdlpJson } from '../engine.mjs';

const HOSTS = ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'];
const MAX_PLAYLIST = 1000;

const stripTopic = s => String(s || '').replace(/ - Topic$/, '');

/** Maps yt-dlp's flat playlist JSON into { name, type, tracks[] }. Private/deleted entries are dropped. */
export function mapYoutubePlaylist(result) {
  const entries = (result.entries || []).filter(e =>
    e?.id && !['[Deleted video]', '[Private video]'].includes(e.title) && !['private', 'premium_only'].includes(e.availability));
  return {
    name: result.title || 'YouTube playlist',
    type: 'playlist',
    tracks: entries.map((e, i) => ({
      title: e.title,
      artist: stripTopic(e.uploader || e.channel),
      duration: e.duration || 0,
      number: i + 1,
      sourceUrl: `https://www.youtube.com/watch?v=${e.id}`,
    })),
  };
}

export const youtube = {
  id: 'youtube',
  label: 'YouTube',

  /** Returns a reference for video/playlist links, null for other hosts. Throws for unsupported YouTube links. */
  parse(u) {
    if (!HOSTS.includes(u.hostname)) return null;
    const list = u.searchParams.get('list');
    // "RD..." lists are auto-generated Mixes; treat the link as its single video instead.
    if (list && !list.startsWith('RD')) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(list)) throw new Error('Invalid YouTube playlist ID.');
      return { playlistId: list };
    }
    const id = u.hostname === 'youtu.be'
      ? u.pathname.slice(1)
      : u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})$/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Use a YouTube video or playlist link.');
    return { url: `https://www.youtube.com/watch?v=${id}` };
  },

  async resolve(ref) {
    if (!ref.playlistId) {
      return { name: '', type: 'track', tracks: [{ title: '', artist: '', number: 1, sourceUrl: ref.url }] };
    }
    const result = await ytdlpJson([
      '--flat-playlist', '--yes-playlist', '--ignore-errors', '--playlist-end', String(MAX_PLAYLIST),
      '--dump-single-json', '--no-warnings', '--', `https://www.youtube.com/playlist?list=${ref.playlistId}`,
    ]);
    const collection = mapYoutubePlaylist(result);
    if (!collection.tracks.length) throw new Error('No playable videos in this YouTube playlist (private?).');
    return collection;
  },
};
