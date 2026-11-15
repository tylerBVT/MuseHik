import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, fileBase, safeName, trackKey, sameLength } from './lib.mjs';
import { detect } from './services/index.mjs';
import { mapSpotifyEntity } from './services/spotify.mjs';
import { mapYoutubePlaylist } from './services/youtube.mjs';
import { mapDeezer } from './services/deezer.mjs';

test('detect: youtube variants', () => {
  for (const u of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?t=3',
    'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=RDx', 'https://www.youtube.com/shorts/jNQXAC9IVRw']) {
    const { service, ref } = detect(u);
    assert.equal(service.id, 'youtube');
    assert.equal(ref.url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  }
});
test('detect: youtube playlists', () => {
  for (const u of ['https://www.youtube.com/playlist?list=PLabcdefghij123',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabcdefghij123',
    'https://music.youtube.com/playlist?list=OLAK5uy_abcdefghij']) {
    const { service, ref } = detect(u);
    assert.equal(service.id, 'youtube');
    assert.ok(ref.playlistId && !ref.url);
  }
});
test('mapYoutubePlaylist drops private/deleted entries and numbers the rest', () => {
  const r = mapYoutubePlaylist({ title: 'Party', entries: [
    { id: 'aaaaaaaaaaa', title: 'One', uploader: 'DJ - Topic', duration: 100 },
    { id: 'bbbbbbbbbbb', title: '[Private video]' },
    { id: 'ccccccccccc', title: 'Two', channel: 'Chan', duration: 200 },
  ] });
  assert.equal(r.tracks.length, 2);
  assert.deepEqual(r.tracks.map(t => [t.number, t.artist, t.sourceUrl]),
    [[1, 'DJ', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'], [2, 'Chan', 'https://www.youtube.com/watch?v=ccccccccccc']]);
});
test('detect: spotify', () => {
  const { service, ref } = detect('https://open.spotify.com/intl-fr/track/3h5T5JypYU7huFiVYhv1dr?si=abc');
  assert.equal(service.id, 'spotify');
  assert.deepEqual(ref, { type: 'track', id: '3h5T5JypYU7huFiVYhv1dr' });
  assert.equal(detect('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M').ref.type, 'playlist');
});
test('detect: deezer', () => {
  for (const [url, type, id] of [
    ['https://www.deezer.com/fr/playlist/14093104361', 'playlist', '14093104361'],
    ['https://www.deezer.com/album/302127', 'album', '302127'],
    ['https://deezer.com/en/track/3135553?utm=x', 'track', '3135553'],
  ]) {
    const { service, ref } = detect(url);
    assert.equal(service.id, 'deezer');
    assert.deepEqual(ref, { type, id });
  }
});
test('detect: rejects unsupported links', () => {
  assert.throws(() => detect('https://example.com/x'), /Supported/);
  assert.throws(() => detect('nope'));
  assert.throws(() => detect('https://www.youtube.com/watch?v=short'));
  assert.throws(() => detect('https://open.spotify.com/artist/3h5T5JypYU7huFiVYhv1dr'));
  assert.throws(() => detect('https://www.deezer.com/fr/artist/27'));
});
test('mapSpotifyEntity', () => {
  const r = mapSpotifyEntity({ name: 'P', trackList: [{ title: 'A', subtitle: 'X, Y', duration: 200000 }] }, 'playlist');
  assert.deepEqual(r.tracks[0], { title: 'A', artist: 'X, Y', duration: 200, number: 1, album: '' });
});
test('mapDeezer: playlist, album, track', () => {
  const t = { title: 'One More Time', duration: 320, artist: { name: 'Daft Punk' } };
  assert.deepEqual(mapDeezer('playlist', { title: 'P' }, [{ ...t, album: { title: 'Discovery' } }]).tracks[0],
    { title: 'One More Time', artist: 'Daft Punk', duration: 320, number: 1, album: 'Discovery', isrc: undefined });
  assert.equal(mapDeezer('album', { title: 'Discovery' }, [t]).tracks[0].album, 'Discovery');
  assert.equal(mapDeezer('track', { ...t, album: { title: 'Discovery' } }).tracks.length, 1);
});
test('bestMatch prefers right duration and title', () => {
  const t = { title: 'Numb', artist: 'Linkin Park', duration: 187 };
  const best = bestMatch(t, [
    { title: 'Numb (Live)', uploader: 'x', duration: 190 },
    { title: 'Linkin Park - Numb (Official Video)', uploader: 'Linkin Park', duration: 188 },
    { title: 'Numb cover', uploader: 'y', duration: 150 },
  ]);
  assert.equal(best.title, 'Linkin Park - Numb (Official Video)');
});
test('fileBase is a flat "Artist - Title"', () => {
  assert.equal(fileBase('A/B', 'C?'), 'A_B - C_');
  assert.equal(fileBase('', 'Me at the zoo'), 'Me at the zoo');
  assert.equal(safeName('..x. '), 'x');
});
test('trackKey: same song across platforms, different versions stay apart', () => {
  const k = trackKey('Daft Punk', 'One More Time');
  assert.equal(trackKey('daft  punk', 'One More Time!'), k);
  assert.equal(trackKey('Daft Punk, Romanthony', 'One More Time (feat. Romanthony)'), k);
  assert.equal(trackKey('Daft Punk', 'One More Time (Radio Edit)') === k, false);
  assert.equal(trackKey('Moderat', 'Bad Kingdom (Live)') === trackKey('Moderat', 'Bad Kingdom'), false);
  assert.equal(trackKey('Beyoncé', 'Halo'), trackKey('Beyonce', 'Halo'));
});
test('sameLength tolerates small drift and unknown durations', () => {
  assert.ok(sameLength(320, 322));
  assert.ok(sameLength(0, 200));
  assert.equal(sameLength(200, 260), false);
});
