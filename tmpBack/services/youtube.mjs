// YouTube service: the link already is the audio source, so there is no track list to look up.
const HOSTS = ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'];

export const youtube = {
  id: 'youtube',
  label: 'YouTube',

  /** Returns a reference for single-video links, null for other hosts. Throws for unsupported YouTube links. */
  parse(u) {
    if (!HOSTS.includes(u.hostname)) return null;
    const id = u.hostname === 'youtu.be'
      ? u.pathname.slice(1)
      : u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})$/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) {
      throw new Error('Only single YouTube videos are supported for now (no playlists yet).');
    }
    return { url: `https://www.youtube.com/watch?v=${id}` };
  },

  /** A collection whose single track already carries its source URL (no search needed). */
  async resolve(ref) {
    return { name: '', type: 'track', tracks: [{ title: '', artist: '', number: 1, sourceUrl: ref.url }] };
  },
};
