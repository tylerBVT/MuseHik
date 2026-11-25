// The PHP music API (music-api/, deployed to LWS) against the laptops' own cloud code: what one writes, the other
// must read exactly. Skipped when no PHP is installed (see php-fixture.mjs).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileBase, safeName, sameIdentity, trackKey } from '../core/lib.mjs';
import { startCloud } from './cloud-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';
import { findPhp, runPhp, startApi } from './php-fixture.mjs';

const skip = findPhp() ? false : 'PHP not found (set MUSEHIK_PHP or install it in MuseHikData\\php-8.1)';

// The laptop side runs on temporary files only (set before the laptops' modules are imported).
const tmp = mkdtempSync(join(tmpdir(), 'music-api-test-'));
mkdirSync(join(tmp, 'library'));
process.env.MUSIC_DIR = join(tmp, 'library');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');
const { withCloud } = await import('../modules/cloud/store.mjs');

/** Uploads a song the way a laptop does (its cloud client). Returns the entry. */
async function laptopUpload(remote, { title, artist = 'Band', seconds = 2, duration = seconds } = {}) {
  const local = join(tmp, `up-${Date.now()}-${Math.random()}.mp3`);
  writeFileSync(local, makeMp3({ title, artist, seconds }));
  return withCloud(cloud => cloud.upload(local, { title, artist, duration, addedBy: 'laptop' }), remote.settings);
}

const NAMES = [
  ['PLK', 'Décembre'],
  ['Ninho feat. Niska', 'Lettre à une femme (feat. Niska)'],
  ['Aya Nakamura, Damso', 'Dégaine'],
  ['', 'Çà et là — Live'],
  ['Björk', 'Jóga'],
  ['  ', '...hidden.'],
  ['A/B', 'C:D*E?"F<G>H|I%'],
  ['Ñandú', 'Œuvre ﬁnale'],
  ['X', 'a'.repeat(150)],
  ['Mötley Crüe', 'Dr. Feelgood (Remastered)'],
  ['Łukasz Żal', 'Ægir ß straße'],
  ['Sch', 'Mannschaft ft. Gims & Jul'],
];

const SAME = [
  [{ isrc: 'FRX123', title: 'a', artist: 'b' }, { isrc: 'frx123', title: 'z', artist: 'y' }],
  [{ title: 'Song', artist: 'Band', duration: 180 }, { title: 'song', artist: 'BAND', duration: 185 }],
  [{ title: 'Song', artist: 'Band', duration: 180 }, { title: 'Song', artist: 'Band', duration: 190 }],
  [{ title: 'Song', artist: 'Band', duration: 0 }, { title: 'Song', artist: 'Band', duration: 200 }],
  [{ title: 'Song', artist: 'Band', key: 'band|song' }, { title: 'Other', artist: 'Band' }],
];

/** The PHP rules applied to NAMES and SAME, as JSON. */
function phpRules(intl) {
  const input = JSON.stringify({ names: NAMES, same: SAME }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return JSON.parse(runPhp(`
    require 'lib/rules.php';
    $in = json_decode('${input}', true);
    $out = ['names' => [], 'same' => []];
    foreach ($in['names'] as [$a, $t]) $out['names'][] = [track_key($a, $t), file_base($a, $t), safe_name($t)];
    foreach ($in['same'] as [$x, $y]) $out['same'][] = same_identity($x, $y);
    echo json_encode($out, JSON_UNESCAPED_UNICODE);
  `, { intl }));
}

describe('music API rules', { skip }, () => {
  for (const intl of [true, false]) {
    test(`the PHP rules give the same results as lib.mjs (${intl ? 'with' : 'without'} intl)`, () => {
      const got = phpRules(intl);
      NAMES.forEach(([artist, title], i) => {
        assert.deepEqual(got.names[i], [trackKey(artist, title), fileBase(artist, title), safeName(title)], `${artist} / ${title}`);
      });
      SAME.forEach(([a, b], i) => assert.equal(got.same[i], sameIdentity(a, b), JSON.stringify([a, b])));
    });
  }
});

describe('music API: reading songs', { skip }, () => {
  let remote, api, cloudDir, one, two;
  const readCloud = name => JSON.parse(readFileSync(join(cloudDir, name), 'utf8'));
  before(async () => {
    remote = await startCloud();
    cloudDir = remote.cloudDir;
    one = await laptopUpload(remote, { title: 'Décembre', artist: 'PLK', seconds: 3 });
    two = await laptopUpload(remote, { title: 'Jóga', artist: 'Björk' });
    api = remote.api;
  });
  after(async () => { await remote?.close(); });

  test('GET /songs lists what the laptops uploaded', async () => {
    const res = await api.call('GET', '/songs');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await res.json()).songs, readCloud('library.json').songs);
  });

  test('a fresh cloud lists no songs and no playlists', async () => {
    const empty = await startApi({ dataDir: mkdtempSync(join(tmpdir(), 'music-api-empty-')) });
    try {
      assert.deepEqual((await (await empty.call('GET', '/songs')).json()).songs, []);
      assert.deepEqual(await (await empty.call('GET', '/playlists')).json(), { playlists: [] });
    } finally { await empty.close(); }
  });

  test('no key or a wrong key is refused', async () => {
    for (const res of [
      await api.call('GET', '/songs', { key: null }),
      await api.call('GET', '/songs', { key: 'wrong' }),
      await api.call('GET', '/songs', { key: null, query: '?key=wrong' }),
    ]) {
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Missing or wrong API key.' });
    }
    assert.equal((await api.call('GET', '/songs', { key: null, query: `?key=${api.key}` })).status, 200);
  });

  test('the file streams whole and by range', async () => {
    const bytes = readFileSync(join(cloudDir, 'songs', one.file));
    const size = bytes.length;
    const path = `/songs/${one.id}/file`;

    const full = await api.call('GET', path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Number(full.headers.get('content-length')), size);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));

    const first = await api.call('GET', path, { headers: { Range: 'bytes=0-99' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.ok(Buffer.from(await first.arrayBuffer()).equals(bytes.subarray(0, 100)));

    const rest = await api.call('GET', path, { headers: { Range: 'bytes=500-' } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), `bytes 500-${size - 1}/${size}`);
    assert.ok(Buffer.from(await rest.arrayBuffer()).equals(bytes.subarray(500)));

    const last = await api.call('GET', path, { headers: { Range: 'bytes=-100' } });
    assert.equal(last.status, 206);
    assert.ok(Buffer.from(await last.arrayBuffer()).equals(bytes.subarray(size - 100)));

    const past = await api.call('GET', path, { headers: { Range: `bytes=${size}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), `bytes */${size}`);

    const head = await api.call('HEAD', path);
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), size);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    // The phone's <audio> element cannot send headers: the key in the address works too.
    assert.equal((await api.call('GET', path, { key: null, query: `?key=${api.key}` })).status, 200);
  });

  test('unknown songs, missing files and path tricks are 404', async () => {
    rmSync(join(cloudDir, 'songs', two.file));
    for (const path of ['/songs/999/file', `/songs/${two.id}/file`, '/songs/..%2F..%2Fconfig.php/file',
      '/songs/1abc/file', '/nothing', '/lib/rules.php', '/config.php']) {
      const res = await api.call('GET', path);
      assert.equal(res.status, 404, path);
      assert.equal(typeof (await res.json()).error, 'string', path);
    }
  });

  test('CORS preflight from the phone app', async () => {
    const pre = await api.call('OPTIONS', '/songs', {
      key: null, headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-API-Key/);
    assert.match(pre.headers.get('access-control-allow-headers'), /Range/);
    assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);

    const stranger = await api.call('OPTIONS', '/songs', { key: null, headers: { Origin: 'https://evil.example' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);

    const normal = await api.call('GET', '/songs', { headers: { Origin: 'https://localhost' } });
    assert.equal(normal.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.match(normal.headers.get('access-control-expose-headers'), /Content-Range/);
  });

  test('a wrong method is 405', async () => {
    const res = await api.call('PUT', '/songs');
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow'), /GET/);
  });
});

/** A playlists.json entry as the laptops write it (playlistSync.mjs forCloud). */
const sharedPlaylist = (uid, name, songs, updatedAt = 1000) => ({
  uid, name, owner: 'Mum', updatedAt,
  songs: songs.map(({ title, artist, album = '', duration = 0, isrc = null, key }) =>
    ({ title, artist, album, duration, isrc, key: key ?? trackKey(artist, title) })),
});

const mp3Form = (name, bytes, fields = {}) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return form;
};

describe('music API: changing songs', { skip }, () => {
  let remote, api, cloudDir;
  const readCloud = name => JSON.parse(readFileSync(join(cloudDir, name), 'utf8'));
  const songsOnDisk = () => readdirSync(join(cloudDir, 'songs'));
  before(async () => {
    remote = await startCloud();
    cloudDir = remote.cloudDir;
    await laptopUpload(remote, { title: 'Already here', artist: 'Band' });
    api = remote.api;
  });
  after(async () => { await remote?.close(); });

  test('upload adds the song the way a laptop would', async () => {
    const nextId = readCloud('library.json').nextId;
    const mp3 = makeMp3({ title: 'Ma dope', artist: 'Nekfeu', seconds: 2 });
    const res = await api.call('POST', '/songs', { body: mp3Form('Nekfeu - Ma dope.mp3', mp3, { addedBy: 'Tyler phone', duration: 120 }) });
    assert.equal(res.status, 201);
    const song = await res.json();
    assert.equal(song.id, nextId);
    assert.equal(song.file, 'Nekfeu - Ma dope.mp3');
    assert.equal(song.title, 'Ma dope');
    assert.equal(song.artist, 'Nekfeu');
    assert.equal(song.key, 'nekfeu|ma dope');
    assert.equal(song.size, mp3.length);
    assert.equal(song.addedBy, 'Tyler phone');
    assert.ok(!Number.isNaN(Date.parse(song.addedAt)));
    assert.equal(readCloud('library.json').nextId, nextId + 1);

    // The laptops' own code sees it and downloads the same bytes.
    const seen = await withCloud(c => c.index(), remote.settings);
    assert.deepEqual(seen.songs.find(s => s.id === song.id), song);
    const copy = join(tmp, 'copy.mp3');
    await withCloud(c => c.download(song, copy), remote.settings);
    assert.ok(readFileSync(copy).equals(mp3));
    assert.deepEqual(songsOnDisk().filter(f => f.includes('.part')), []);
  });

  test('upload with explicit title and artist, and a taken file name', async () => {
    // Same title and artist but a very different length: another version, kept apart.
    const res = await api.call('POST', '/songs', {
      body: mp3Form('whatever.mp3', makeMp3({ seconds: 4 }), { title: 'Ma dope', artist: 'Nekfeu', duration: 240.5, album: 'Feu' }),
    });
    assert.equal(res.status, 201);
    const song = await res.json();
    assert.equal(song.file, 'Nekfeu - Ma dope (2).mp3');
    assert.equal(song.duration, 240.5);
    assert.equal(song.album, 'Feu');
    assert.equal(song.addedBy, 'phone');
  });

  test('upload refusals', async () => {
    const small = await startApi({ dataDir: cloudDir, config: { maxUploadMB: 1 } });
    const full = await startApi({ dataDir: cloudDir, config: { storageLimitGB: 0.000001 } });
    try {
      const txt = await api.call('POST', '/songs', { body: mp3Form('notes.txt', Buffer.from('hello')) });
      assert.equal(txt.status, 415);

      const big = await small.call('POST', '/songs', { body: mp3Form('Big - Song.mp3', Buffer.alloc(1.5e6)) });
      assert.equal(big.status, 413);

      const again = await api.call('POST', '/songs', { body: mp3Form('Band - Already here.mp3', makeMp3({ seconds: 2 })) });
      assert.equal(again.status, 409);
      assert.equal((await again.json()).song.title, 'Already here');

      const over = await full.call('POST', '/songs', { body: mp3Form('New - One.mp3', makeMp3({ seconds: 1 })) });
      assert.equal(over.status, 413);
      assert.match((await over.json()).error, /^Not enough cloud storage/);

      const none = await api.call('POST', '/songs', { body: new FormData() });
      assert.equal(none.status, 400);
    } finally { await small.close(); await full.close(); }
    assert.deepEqual(songsOnDisk().filter(f => /notes|Big|New - One|\.part/.test(f)), []);
  });

  test('rename changes the title, the file name and shared playlists', async () => {
    const song = await laptopUpload(remote, { title: 'Old name', artist: 'Band', seconds: 2 });
    const other = { title: 'Someone else', artist: 'Else', duration: 100 };
    writeFileSync(join(cloudDir, 'playlists.json'), JSON.stringify({
      version: 1, playlists: [sharedPlaylist('p-1', 'Mix', [song, other]), sharedPlaylist('p-2', 'Other', [other])],
    }));
    const res = await api.call('PATCH', `/songs/${song.id}`, { body: { title: 'New' } });
    assert.equal(res.status, 200);
    const renamed = await res.json();
    assert.equal(renamed.id, song.id);
    assert.equal(renamed.file, 'Band - New.mp3');
    assert.equal(renamed.key, 'band|new');
    assert.ok(songsOnDisk().includes('Band - New.mp3'));
    assert.ok(!songsOnDisk().includes(song.file));
    const [mix, untouched] = readCloud('playlists.json').playlists;
    assert.equal(mix.songs[0].title, 'New');
    assert.equal(mix.songs[0].key, 'band|new');
    assert.ok(mix.updatedAt > 1000);
    assert.equal(untouched.updatedAt, 1000);

    const twin = await laptopUpload(remote, { title: 'Twin', artist: 'Band', seconds: 2 });
    const clash = await (await api.call('PATCH', `/songs/${twin.id}`, { body: { title: 'New' } })).json();
    assert.equal(clash.file, 'Band - New (2).mp3');
  });

  test('rename refusals', async () => {
    const id = readCloud('library.json').songs[0].id;
    const empty = await api.call('PATCH', `/songs/${id}`, { body: { title: '  ' } });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'A song needs a title.');
    const long = await api.call('PATCH', `/songs/${id}`, { body: { title: 'x'.repeat(201) } });
    assert.equal(long.status, 400);
    assert.equal((await long.json()).error, 'That is too long.');
    assert.equal((await api.call('PATCH', '/songs/999', { body: { title: 'X' } })).status, 404);
  });

  test('delete removes the file and the entry', async () => {
    const song = await laptopUpload(remote, { title: 'Bye', artist: 'Band', seconds: 1 });
    const playlistsBefore = readFileSync(join(cloudDir, 'playlists.json'), 'utf8');
    const res = await api.call('DELETE', `/songs/${song.id}`);
    assert.equal(res.status, 204);
    assert.ok(!songsOnDisk().includes(song.file));
    assert.equal(readCloud('library.json').songs.some(s => s.id === song.id), false);
    assert.equal(readFileSync(join(cloudDir, 'playlists.json'), 'utf8'), playlistsBefore);
    assert.equal((await api.call('DELETE', `/songs/${song.id}`)).status, 404);
  });
});

describe('music API: playlists', { skip }, () => {
  let remote, api, cloudDir, a, b;
  const readCloud = name => JSON.parse(readFileSync(join(cloudDir, name), 'utf8'));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  before(async () => {
    remote = await startCloud();
    cloudDir = remote.cloudDir;
    a = await laptopUpload(remote, { title: 'Alpha', artist: 'Band', seconds: 2 });
    b = await laptopUpload(remote, { title: 'Beta', artist: 'Band', seconds: 3 });
    api = remote.api;
  });
  after(async () => { await remote?.close(); });

  test('playlists made by a laptop show with playable song ids', async () => {
    const missing = { title: 'Not uploaded', artist: 'Nobody', duration: 200 };
    writeFileSync(join(cloudDir, 'playlists.json'), JSON.stringify({
      version: 1,
      playlists: [sharedPlaylist('uid-1', 'Mix', [a, missing, b]), { uid: 'uid-2', deleted: true, updatedAt: 5 }],
    }));
    const res = await api.call('GET', '/playlists');
    assert.equal(res.status, 200);
    const { playlists } = await res.json();
    assert.equal(playlists.length, 1);
    const [mix] = playlists;
    assert.equal(mix.id, 'uid-1');
    assert.equal(mix.name, 'Mix');
    assert.equal(mix.owner, 'Mum');
    assert.equal(mix.updatedAt, 1000);
    assert.deepEqual(mix.songs.map(s => s.songId), [a.id, null, b.id]);
    assert.equal(mix.songs[1].title, 'Not uploaded');
  });

  test('create, rename, change songs, delete', async () => {
    const start = Date.now();
    const made = await api.call('POST', '/playlists', { body: { name: ' Road trip ', owner: 'Tyler', songs: [{ id: a.id }] } });
    assert.equal(made.status, 201);
    const p = await made.json();
    assert.match(p.id, UUID);
    assert.equal(p.name, 'Road trip');
    assert.equal(p.owner, 'Tyler');
    assert.ok(p.updatedAt >= start && p.updatedAt <= Date.now());
    assert.deepEqual(p.songs, [{ title: 'Alpha', artist: 'Band', album: '', duration: 2, isrc: null, key: 'band|alpha', songId: a.id }]);
    const stored = readCloud('playlists.json').playlists.find(x => x.uid === p.id);
    assert.deepEqual(stored.songs, [{ title: 'Alpha', artist: 'Band', album: '', duration: 2, isrc: null, key: 'band|alpha' }]);

    await new Promise(r => setTimeout(r, 5));
    const renamed = await (await api.call('PATCH', `/playlists/${p.id}`, { body: { name: 'Summer' } })).json();
    assert.equal(renamed.name, 'Summer');
    assert.equal(renamed.songs.length, 1, 'songs kept when only the name changes');
    assert.ok(renamed.updatedAt > p.updatedAt);

    const elsewhere = { title: 'Live only', artist: 'Mum band', album: 'X', duration: 99, isrc: null, key: 'mum band|live only' };
    const changed = await (await api.call('PATCH', `/playlists/${p.id}`, { body: { songs: [{ id: b.id }, elsewhere] } })).json();
    assert.deepEqual(changed.songs.map(s => [s.title, s.songId]), [['Beta', b.id], ['Live only', null]]);
    assert.equal(changed.name, 'Summer');

    const gone = await api.call('DELETE', `/playlists/${p.id}`);
    assert.equal(gone.status, 204);
    const marker = readCloud('playlists.json').playlists.find(x => x.uid === p.id);
    assert.equal(marker.deleted, true);
    assert.ok(marker.updatedAt >= changed.updatedAt);
    assert.equal(Object.keys(marker).sort().join(), 'deleted,uid,updatedAt');
    const { playlists } = await (await api.call('GET', '/playlists')).json();
    assert.equal(playlists.some(x => x.id === p.id), false);
    assert.equal((await api.call('PATCH', `/playlists/${p.id}`, { body: { name: 'X' } })).status, 404);
    assert.equal((await api.call('DELETE', `/playlists/${p.id}`)).status, 404);
    assert.equal((await api.call('DELETE', '/playlists/no-such-uid')).status, 404);
  });

  test('playlist refusals', async () => {
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }]) {
      const res = await api.call('POST', '/playlists', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await api.call('POST', '/playlists', { body: { name: 'Ok', songs: 'nope' } })).status, 400);
    const unknown = await api.call('POST', '/playlists', { body: { name: 'Ok', songs: [{ id: 999 }] } });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error, 'Unknown song 999.');
    const broken = await api.call('POST', '/playlists', { body: '{oops', headers: { 'Content-Type': 'application/json' } });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).error, 'The body is not valid JSON.');
  });

  test('a laptop picks up a playlist made through the API, and drops it when deleted', async () => {
    const { saveSettings } = await import('../modules/cloud/settings.mjs');
    const { syncPlaylists } = await import('../modules/cloud/playlistSync.mjs');
    const P = await import('../modules/musicPlayer/playlists.mjs');
    saveSettings({ ...remote.settings, name: 'Laptop' });

    const made = await (await api.call('POST', '/playlists', { body: { name: 'From phone', owner: 'Tyler', songs: [{ id: a.id }, { id: b.id }] } })).json();
    await syncPlaylists();
    const local = P.playlistRows().find(r => r.uid === made.id);
    assert.ok(local, 'the laptop has the playlist');
    assert.equal(local.name, 'From phone');
    assert.equal(local.owner, 'Tyler');
    assert.deepEqual(local.songs.map(s => s.title), ['Alpha', 'Beta']);

    assert.equal((await api.call('DELETE', `/playlists/${made.id}`)).status, 204);
    await syncPlaylists();
    assert.equal(P.playlistRows().some(r => r.uid === made.id), false, 'the laptop dropped it');
  });
});

describe('music API: what the laptops need', { skip }, () => {
  let api, cloudDir;
  const readCloud = name => JSON.parse(readFileSync(join(cloudDir, name), 'utf8'));
  const writeCloud = (name, data) => writeFileSync(join(cloudDir, name), JSON.stringify(data));
  const entry = (id, file, size = 10) => ({
    id, file, title: file.replace(/\.\w+$/, ''), artist: '', album: '', duration: 100, isrc: null,
    key: trackKey('', file.replace(/\.\w+$/, '')), size, addedBy: 'laptop', addedAt: '2026-01-01T00:00:00.000Z',
  });
  before(async () => {
    cloudDir = mkdtempSync(join(tmpdir(), 'music-api-laptops-'));
    mkdirSync(join(cloudDir, 'songs'));
    api = await startApi({ dataDir: cloudDir, config: { storageLimitGB: 2 } });
  });
  after(async () => { await api?.close(); });

  test('GET /status reports storage and the number of songs', async () => {
    writeFileSync(join(cloudDir, 'songs', 'One.mp3'), Buffer.alloc(300));
    writeCloud('library.json', { version: 1, nextId: 2, songs: [entry(1, 'One.mp3', 300)] });
    const res = await api.call('GET', '/status');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { storedBytes: 300, storageLimitBytes: 2e9, songs: 1 });
  });

  test('GET /songs picks up songs added by hand and drops songs whose file is gone', async () => {
    writeFileSync(join(cloudDir, 'songs', 'PLK - Pas les mêmes.mp3'), Buffer.alloc(1234));
    writeFileSync(join(cloudDir, 'songs', 'Lonely.flac'), Buffer.alloc(5));
    writeFileSync(join(cloudDir, 'songs', 'Half.part.mp3'), Buffer.alloc(5));
    writeFileSync(join(cloudDir, 'songs', 'notes.txt'), 'x');
    writeCloud('library.json', { version: 1, nextId: 3, songs: [entry(1, 'One.mp3', 300), entry(2, 'Gone.mp3')] });
    const res = await api.call('GET', '/songs');
    const { songs, synced } = await res.json();
    assert.deepEqual(synced, { added: 2, removed: 1 });
    assert.deepEqual(songs.map(s => s.file).sort(), ['Lonely.flac', 'One.mp3', 'PLK - Pas les mêmes.mp3']);
    const plk = songs.find(s => s.file.startsWith('PLK'));
    assert.equal(plk.artist, 'PLK');
    assert.equal(plk.title, 'Pas les mêmes');
    assert.equal(plk.key, trackKey('PLK', 'Pas les mêmes'));
    assert.equal(plk.size, 1234);
    assert.equal(plk.addedBy, 'added by hand');
    assert.equal(plk.duration, 0);
    assert.ok(!Number.isNaN(Date.parse(plk.addedAt)));
    assert.equal(songs.find(s => s.file === 'Lonely.flac').artist, '');
    assert.ok(new Set(songs.map(s => s.id)).size === 3 && Math.min(...songs.filter(s => s.addedBy === 'added by hand').map(s => s.id)) >= 3);
    assert.deepEqual(readCloud('library.json').songs, songs, 'written to library.json');

    const again = await (await api.call('GET', '/songs')).json();
    assert.deepEqual(again.synced, { added: 0, removed: 0 });
  });

  test('an empty songs folder never empties the list', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'music-api-nofiles-'));
    writeFileSync(join(empty, 'library.json'), JSON.stringify({ version: 1, nextId: 2, songs: [entry(1, 'One.mp3')] }));
    const other = await startApi({ dataDir: empty });
    try {
      const { songs, synced } = await (await other.call('GET', '/songs')).json();
      assert.equal(songs.length, 1);
      assert.deepEqual(synced, { added: 0, removed: 0 });
    } finally { await other.close(); }
  });

  test('PATCH also fills album, length and ISRC (tags read on a laptop)', async () => {
    const { songs } = await (await api.call('GET', '/songs')).json();
    const plk = songs.find(s => s.file.startsWith('PLK'));
    const res = await api.call('PATCH', `/songs/${plk.id}`, { body: { album: 'Enna', duration: 187.4, isrc: 'FR10S2000001' } });
    assert.equal(res.status, 200);
    const after = await res.json();
    assert.equal(after.album, 'Enna');
    assert.equal(after.duration, 187.4);
    assert.equal(after.isrc, 'FR10S2000001');
    assert.equal(after.file, plk.file, 'no rename when title and artist stay');
    assert.equal((await api.call('PATCH', `/songs/${plk.id}`, { body: { duration: -1 } })).status, 400);
    assert.equal((await api.call('PATCH', `/songs/${plk.id}`, { body: { isrc: 'x'.repeat(40) } })).status, 400);
  });

  test('POST /songs keeps the ISRC sent by a laptop', async () => {
    const res = await api.call('POST', '/songs', {
      body: mp3Form('Isrc - Song.mp3', makeMp3({ seconds: 1 }), { isrc: 'USRC17607839', duration: 1 }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).isrc, 'USRC17607839');
  });

  test('raw playlists include delete markers', async () => {
    writeCloud('playlists.json', { version: 1, playlists: [sharedPlaylist('p-1', 'Mix', []), { uid: 'p-2', deleted: true, updatedAt: 7 }] });
    const res = await api.call('GET', '/playlists', { query: '?raw=1' });
    assert.deepEqual((await res.json()).playlists, readCloud('playlists.json').playlists);
  });

  test('PUT stores a playlist only when it is newer (last change wins, decided on the server)', async () => {
    const song = { title: 'A', artist: 'B', album: '', duration: 10, isrc: null, key: 'b|a' };
    const fresh = { name: 'Road', owner: 'Tyler', updatedAt: 2000, songs: [song] };
    let res = await api.call('PUT', '/playlists/p-new', { body: fresh });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { applied: true, playlist: { uid: 'p-new', ...fresh } });

    res = await api.call('PUT', '/playlists/p-new', { body: { ...fresh, name: 'Older', updatedAt: 1500 } });
    assert.deepEqual(await res.json(), { applied: false, playlist: { uid: 'p-new', ...fresh } });
    res = await api.call('PUT', '/playlists/p-new', { body: { ...fresh, name: 'Same time', updatedAt: 2000 } });
    assert.equal((await res.json()).applied, false);

    res = await api.call('PUT', '/playlists/p-1', { body: { ...fresh, name: 'Mix 2', updatedAt: 3000 } });
    assert.equal((await res.json()).applied, true);
    res = await api.call('PUT', '/playlists/p-new', { body: { deleted: true, updatedAt: 4000 } });
    assert.deepEqual(await res.json(), { applied: true, playlist: { uid: 'p-new', deleted: true, updatedAt: 4000 } });
    const stored = readCloud('playlists.json').playlists;
    assert.equal(stored.find(p => p.uid === 'p-1').name, 'Mix 2');
    assert.deepEqual(stored.find(p => p.uid === 'p-new'), { uid: 'p-new', deleted: true, updatedAt: 4000 });
    // A playlist edited after it was deleted elsewhere comes back (the edit is newer).
    res = await api.call('PUT', '/playlists/p-new', { body: { ...fresh, updatedAt: 5000 } });
    assert.equal((await res.json()).applied, true);

    for (const body of [{}, { name: 'x', updatedAt: 'soon', songs: [] }, { name: '', owner: 'a', updatedAt: 9000, songs: [] },
      { name: 'x', updatedAt: 9000, songs: 'no' }, { deleted: true }]) {
      assert.equal((await api.call('PUT', '/playlists/p-bad', { body })).status, 400, JSON.stringify(body));
    }
  });
});

describe('music API: odd input', { skip }, () => {
  let api, cloudDir, song;
  before(async () => {
    // A folder name with [ and ]: glob() would read those as a pattern.
    cloudDir = mkdtempSync(join(tmpdir(), 'music [api] '));
    mkdirSync(join(cloudDir, 'songs'));
    api = await startApi({ dataDir: cloudDir });
    song = await (await api.call('POST', '/songs', { body: mp3Form('Band - First.mp3', makeMp3({ seconds: 1 })) })).json();
  });
  after(async () => { await api?.close(); });

  test('fields of the wrong type are refused with 400, never a server error', async () => {
    const tries = [
      ['PATCH', `/songs/${song.id}`, { title: ['x'] }],
      ['PATCH', `/songs/${song.id}`, { artist: { a: 1 } }],
      ['PATCH', `/songs/${song.id}`, { genre: [1] }],
      ['PATCH', `/songs/${song.id}`, { album: true }],
      ['POST', '/playlists', { name: ['x'] }],
      ['POST', '/playlists', { name: 'Ok', owner: {} }],
      ['POST', '/playlists', { name: 'Ok', songs: [{ title: ['x'] }] }],
      ['POST', '/playlists', { name: 'Ok', songs: [{ title: 'x', artist: [] }] }],
      ['PUT', '/playlists/pl-1', { name: 'Ok', owner: [1], updatedAt: 5, songs: [] }],
    ];
    // ISRC and length have their own messages; still 400, and nothing broken gets stored.
    for (const extra of [{ isrc: [1] }, { duration: 'long' }, { duration: {} }]) {
      const res = await api.call('POST', '/playlists', { body: { name: 'Ok', songs: [{ title: 'x', ...extra }] } });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal((await api.call('GET', '/playlists')).status, 200);
    for (const [method, path, body] of tries) {
      const res = await api.call(method, path, { body });
      assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
      assert.match((await res.json()).error, /must be text/);
    }
    for (const field of ['title', 'artist', 'album', 'addedBy']) {
      const form = mp3Form('Band - Second.mp3', makeMp3({ seconds: 1 }));
      form.append(`${field}[]`, 'x');
      const res = await api.call('POST', '/songs', { body: form });
      assert.equal(res.status, 400, field);
    }
    const res = await api.call('GET', '/songs', { key: null, query: '?key[]=x' });
    assert.equal(res.status, 401);
    // Numbers are still fine as text.
    const ok = await api.call('PATCH', `/songs/${song.id}`, { body: { title: 1999 } });
    assert.equal((await ok.json()).title, '1999');
  });

  test('no answer may be kept by a cache in front of the hosting (it would serve it without the key)', async () => {
    const answers = [
      await api.call('GET', '/status'),
      await api.call('GET', '/songs'),
      await api.call('GET', `/songs/${song.id}/file`),
      await api.call('GET', `/songs/${song.id}/file`, { headers: { Range: 'bytes=0-9' } }),
      await api.call('GET', '/status', { key: null }),
      await api.call('GET', '/nothing'),
      await api.call('OPTIONS', '/songs', { key: null, headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'GET' } }),
    ];
    for (const res of answers) {
      assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${res.url} ${res.status}`);
      assert.match(res.headers.get('cache-control') ?? '', /private/);
      await res.arrayBuffer();
    }
  });

  test('a file put in songs/ by hand is never overwritten, even in a folder named with [ ]', async () => {
    writeFileSync(join(cloudDir, 'songs', 'Band - Hand.mp3'), 'by hand');
    const res = await api.call('POST', '/songs', { body: mp3Form('Band - Hand.mp3', makeMp3({ seconds: 1 })) });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).file, 'Band - Hand (2).mp3');
    assert.equal(readFileSync(join(cloudDir, 'songs', 'Band - Hand.mp3'), 'utf8'), 'by hand');
  });
});
