import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, cleanUploadTitle, fileBase, rankMatches, safeName, sameSong, trackKey, sameLength } from '../core/lib.mjs';
import { explain } from '../modules/musicDownloader/errors.mjs';
import { detect } from '../modules/musicDownloader/services/index.mjs';
import { mapSpotifyEntity } from '../modules/musicDownloader/services/spotify.mjs';
import { mapYoutubePlaylist } from '../modules/musicDownloader/services/youtube.mjs';
import { mapDeezer } from '../modules/musicDownloader/services/deezer.mjs';

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

test('cleanUploadTitle strips upload decorations but keeps versions', () => {
  assert.equal(cleanUploadTitle('PLK - Décembre | A COLORS SHOW'), 'PLK - Décembre');
  assert.equal(cleanUploadTitle('Décembre - A COLORS SHOW'), 'Décembre');
  assert.equal(cleanUploadTitle('PLK - Demain (Clip Officiel)'), 'PLK - Demain');
  assert.equal(cleanUploadTitle('Song [Official Music Video] - Lyrics'), 'Song');
  assert.equal(cleanUploadTitle('Song (Live at Bercy)'), 'Song (Live at Bercy)');
  assert.equal(cleanUploadTitle('Song (Remix)'), 'Song (Remix)');
});

test('sameSong: different uploads of one recording match, other songs do not', () => {
  const clean = { artist: 'PLK', title: 'Décembre', duration: 139 };
  assert.ok(sameSong(clean, { artist: 'COLORS', title: 'PLK - Décembre ｜ A COLORS SHOW', duration: 139.4 }));
  assert.ok(sameSong(clean, { artist: 'PLK, COLORS', title: 'Décembre - A COLORS SHOW', duration: 138.7 }));
  assert.ok(sameSong(clean, { artist: 'PLKVEVO', title: 'PLK - Décembre (Clip Officiel)', duration: 141 }));
  assert.ok(!sameSong(clean, { artist: 'COLORS', title: 'PLK - Décembre', duration: 160 }), 'different length');
  assert.ok(!sameSong(clean, { artist: 'Luv Resval', title: 'Décembre', duration: 139 }), 'different artist');
  assert.ok(!sameSong(clean, { artist: 'PLK', title: 'Demain', duration: 139 }), 'different title');
  assert.ok(!sameSong(clean, { artist: 'PLK', title: 'Décembre', duration: 0 }), 'unknown length never matches loosely');
});

test('rankMatches: best first, poor candidates dropped', () => {
  const track = { artist: 'PLK', title: 'Décembre', duration: 139 };
  const ranked = rankMatches(track, [
    { id: 'a', title: 'PLK - A la base (clip officiel)', channel: 'PLK TV', duration: 268 },
    { id: 'b', title: 'PLK - Décembre | A COLORS SHOW', channel: 'COLORS', duration: 139 },
    { id: 'c', title: 'Décembre', channel: 'PLK - Topic', duration: 140 },
  ]);
  assert.deepEqual(ranked.map(c => c.id), ['c', 'b']);
});

test('explain: classifies yt-dlp errors', () => {
  assert.equal(explain(new Error("ERROR: [youtube] x: Sign in to confirm you’re not a bot.")).kind, 'blocked');
  assert.equal(explain(new Error('ERROR: [soundcloud] 1: This video is DRM protected')).kind, 'unavailable');
  assert.equal(explain(new Error('ERROR: [youtube] x: Requested format is not available')).kind, 'outdated');
  assert.equal(explain(new Error('ERROR: [youtube] x: Video unavailable')).kind, 'unavailable');
  assert.equal(explain(new Error('ERROR: [youtube] x: This video is unavailable')).kind, 'unavailable');
  assert.equal(explain(new Error('Deezer: no data.')).kind, 'other');
});

test('download report: groups failures, flags odd downloads, explains skips', async () => {
  const { renderReport, suspicious } = await import('../modules/musicDownloader/report.mjs');
  const song = (number, artist, title, duration) => ({ number, artist, title, album: '', duration, isrc: '', url: '' });
  const job = {
    url: 'https://www.deezer.com/playlist/1', name: 'Test', platform: 'deezer', status: 'done', total: 5,
    startedAt: '2026-11-17T10:00:00Z', finishedAt: '2026-11-17T11:00:00Z', ytdlp: '2026.10.26', notes: [],
    failed: [
      { track: 'A - One', song: song(1, 'A', 'One', 200), kind: 'unavailable', error: 'This video no longer exists (removed or deleted).',
        stage: 'download (upload 1 of 1)', candidates: [{ url: 'https://www.youtube.com/watch?v=x', title: 'A - One', channel: 'A', duration: 201 }],
        attempts: [{ url: 'https://www.youtube.com/watch?v=x', kind: 'unavailable', error: 'ERROR: [youtube] x: Video unavailable' }], detail: '' },
      { track: 'B - Two', song: song(2, 'B', 'Two', 180), kind: 'other', error: 'No matching video was found on YouTube for this song.', stage: 'YouTube search', candidates: [], attempts: [] },
    ],
    downloaded: [
      { track: 'C - Three', song: song(3, 'C', 'Three', 180), file: 'C - Three.mp3', used: { url: 'u', title: 'C - Three (Live)', channel: 'C', duration: 240, rank: 1 } },
      { track: 'D - Four', song: song(4, 'D', 'Four', 180), file: 'D - Four.mp3', used: { url: 'u', title: 'D - Four', channel: 'D - Topic', duration: 181, rank: 1 } },
    ],
    skippedList: [{ track: 'E - Five', song: song(5, 'E', 'Five', 150), reason: 'x',
      match: { id: 9, artist: 'E', title: 'Five', duration: 151, file: 'E - Five.mp3', matchedBy: 'same ISRC' } }],
  };
  const text = renderReport(job);
  assert.match(text, /FAILED BY REASON \(2\)/);
  assert.match(text, /#1 A - One/);
  assert.match(text, /-> ERROR: \[youtube\] x: Video unavailable/);
  assert.match(text, /step:   YouTube search/);
  assert.match(text, /MAYBE THE WRONG VERSION \(1\)/);
  assert.match(text, /#3 C - Three[\s\S]*length 4:00 instead of 3:00/);
  assert.doesNotMatch(text, /#4 D - Four[\s\S]*check:/);
  assert.match(text, /#5 E - Five[\s\S]*same as: #9 E - Five \(2:31\) \[same ISRC\]/);
  assert.equal(suspicious(job.downloaded[1]), null);
});
