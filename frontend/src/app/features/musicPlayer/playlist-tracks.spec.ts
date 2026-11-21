import { PlaylistSong, toTracks } from './playlist.service';

const song = (title: string, trackId: number | null, cloudId: number | null): PlaylistSong => ({
  title, artist: 'A', album: 'B', duration: 120, isrc: null, key: `a|${title}`, trackId, cloudId,
});

describe('playlist songs', () => {
  it('map to library, cloud and unavailable tracks', () => {
    const tracks = toTracks([song('Here', 5, null), song('Up there', null, 9), song('Gone', null, null)]);
    expect(tracks.map((t) => t.title)).toEqual(['Here', 'Up there', 'Gone']);

    expect(tracks[0].id).toBe(5);
    expect(tracks[0].stream).toBeUndefined();
    expect(tracks[0].unavailable).toBeFalsy();

    expect(tracks[1].id).toBe(-9);
    expect(tracks[1].stream).toContain('/cloud/songs/9/stream');
    expect(tracks[1].prefetch).toContain('/cloud/songs/9/prefetch');

    expect(tracks[2].unavailable).toBe(true);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(3);
  });
});
