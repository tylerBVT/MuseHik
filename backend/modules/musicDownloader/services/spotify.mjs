// Spotify service: metadata only, read from the public embed page. Audio is matched on YouTube later.

/** Normalises a Spotify embed "entity" into { name, type, tracks[] }. */
export function mapSpotifyEntity(entity, type) {
  const artists = e => e.subtitle || e.artists?.map(a => a.name).join(', ') || '';
  const list = entity.trackList || (type === 'track' ? [entity] : []);
  const tracks = list
    .filter(t => t && (t.title || t.name))
    .map((t, i) => ({
      title: t.title || t.name,
      artist: artists(t) || artists(entity),
      duration: (t.duration || 0) / 1000,
      number: i + 1,
      album: type === 'album' ? entity.name || entity.title : '',
    }));
  return { name: entity.name || entity.title || 'Spotify', type, tracks };
}

export const spotify = {
  id: 'spotify',
  label: 'Spotify',

  parse(u) {
    if (u.hostname !== 'open.spotify.com') return null;
    const m = u.pathname.match(/^\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([a-zA-Z0-9]{22})\/?$/);
    if (!m) throw new Error('Use a Spotify track, album or playlist link.');
    return { type: m[1], id: m[2] };
  },

  async resolve({ type, id }) {
    const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`,
      { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`Spotify returned HTTP ${res.status}.`);
    const m = (await res.text()).match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const entity = m && JSON.parse(m[1]).props?.pageProps?.state?.data?.entity;
    if (!entity) throw new Error('Spotify changed its public embed page; cannot read this link.');
    const collection = mapSpotifyEntity(entity, type);
    if (!collection.tracks.length) throw new Error('No tracks found in this Spotify link.');
    return collection;
  },
};
