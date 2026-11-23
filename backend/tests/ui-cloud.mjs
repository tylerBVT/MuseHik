// Drives the cloud pages in real Chrome against a throw-away setup: a local FTP server (stands in for the LWS
// hosting), a temporary library with 1 song, and a temporary folder with 2 more. Nothing real is touched.
// Needs the built app (cd frontend; npx ng build) and Chrome.   node tests/ui-cloud.mjs [screenshot folder]
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openPage, wait } from './cdp.mjs';
import { startFtp } from './ftp-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'musehik-ui-cloud-'));
const realConfig = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const sample = readdirSync(realConfig.musicDir).filter(f => f.endsWith('.mp3')).slice(0, 3);
mkdirSync(join(tmp, 'music'));
mkdirSync(join(tmp, 'folder'));
copyFileSync(join(realConfig.musicDir, sample[0]), join(tmp, 'music', sample[0]));
for (const f of sample.slice(1)) copyFileSync(join(realConfig.musicDir, f), join(tmp, 'folder', f));
process.env.MUSIC_DIR = join(tmp, 'music');
process.env.LIBRARY_DB = join(tmp, 'test.db');
process.env.CLOUD_SETTINGS = join(tmp, 'cloud.json');
process.env.CLOUD_CACHE_DIR = join(tmp, 'cache');

// The server only accepts browser requests from its own port (CORS), so it must know the port before it loads.
process.env.PORT = await new Promise(resolve => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(String(port))); });
});

const ftp = await startFtp();
const { server } = await import('../server.mjs');
const { scanLibrary } = await import('../core/library.mjs');
await scanLibrary();
await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${server.address().port}`;
const API = `${APP}/api`;

const page = await openPage(APP, process.argv[2]);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const q = expr => page.evaluate(expr);
const click = (selector, text) => q(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})).click()`);
const typeInField = (label, value) => q(`(() => {
  const field = [...document.querySelectorAll('app-settings .field')].find(f => f.querySelector('.label').textContent.trim() === ${JSON.stringify(label)});
  const input = field.querySelector('input'); input.value = ${JSON.stringify(String(value))};
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const songs = async () => (await (await fetch(`${API}/cloud/songs`)).json()).songs;

try {
  // Home tiles
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 6`);
  const tiles = await q(`[...document.querySelectorAll('app-home .tile .name')].map(e => e.textContent.trim())`);
  const at = tiles.indexOf('Create playlist');
  check('home has Cloud upload and Cloud right after Create playlist', tiles[at + 1] === 'Cloud upload' && tiles[at + 2] === 'Cloud', tiles.join(' | '));

  // Not set up yet: the usage bar says so
  await click('app-home .tile', 'Cloud upload');
  check('before setup the upload page points to Settings', await page.waitFor(`document.querySelector('app-cloud-usage')?.textContent.includes('not set up')`));

  // Settings
  await q(`history.back()`);
  await page.waitFor(`document.querySelector('.gear')`);
  await q(`document.querySelector('.gear').click()`);
  await page.waitFor(`document.querySelectorAll('app-settings .field').length >= 8`);
  await typeInField('Host', ftp.settings.host);
  await typeInField('Port', ftp.settings.port);
  await typeInField('User', ftp.settings.user);
  await typeInField('Password', ftp.settings.password);
  await typeInField('Your name', 'Tyler');
  await q(`document.querySelector('app-settings .check input').click()`);
  await click('app-settings .action', 'Save and test');
  check('Save and test connects', await page.waitFor(`document.querySelector('app-settings [role=status]')?.textContent.includes('Connected')`),
    await q(`document.querySelector('app-settings [role=status]')?.textContent.trim()`));
  check('the password field is emptied after saving', (await q(`[...document.querySelectorAll('app-settings .field input')].find(i => i.type === 'password').value`)) === '');
  await page.shot('cloud-1-settings');

  // Upload: Songs tab (the library song), then Folder tab (two songs from outside the library)
  await q(`history.back()`);
  await page.waitFor(`document.querySelector('app-home')`);
  await click('app-home .tile', 'Cloud upload');
  check('usage bar shows storage and this month', await page.waitFor(`document.querySelector('app-cloud-usage')?.textContent.includes('Moved this month')`));
  await page.waitFor(`document.querySelectorAll('app-cloud-upload-page .song').length === 1`);
  await q(`document.querySelector('app-cloud-upload-page .song input').click()`);
  check('summary counts the ticked song', (await q(`document.querySelector('app-cloud-upload-page .send').textContent`)).includes('1 song,'));
  await click('app-cloud-upload-page .send .action', 'Upload');
  check('first upload finishes', await page.waitFor(`document.querySelector('app-cloud-upload-page .summary')?.textContent.includes('1 uploaded')`, 60000));

  await click('app-cloud-upload-page .tab', 'Folder');
  await q(`(() => { const i = document.querySelector('app-cloud-upload-page input[aria-label="Folder path"]'); i.value = ${JSON.stringify(join(tmp, 'folder'))}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('app-cloud-upload-page .action', 'List songs');
  check('the folder lists its 2 songs, ticked', await page.waitFor(`document.querySelectorAll('app-cloud-upload-page .song input:checked').length === 2`));
  await page.shot('cloud-2-upload-folder');
  await click('app-cloud-upload-page .send .action', 'Upload');
  check('folder upload finishes', await page.waitFor(`document.querySelector('app-cloud-upload-page .summary')?.textContent.includes('2 uploaded')`, 60000));
  check('usage bar moved above 0 MB', await page.waitFor(`!document.querySelector('app-cloud-usage strong')?.textContent.startsWith('0 MB')`),
    await q(`document.querySelector('app-cloud-usage .line')?.textContent.trim()`));
  await page.shot('cloud-3-upload-done');

  // Cloud page: plays like a playlist
  await q(`history.back()`);
  await page.waitFor(`document.querySelector('app-home')`);
  await click('app-home .tile', 'Listen online');
  check('the Cloud page lists the 3 songs', await page.waitFor(`document.querySelectorAll('app-cloud-page app-library-list .row').length === 3`));
  check('only the library song is marked "on this laptop"', (await q(`document.querySelectorAll('app-cloud-page .badge').length`)) === 1);
  const before = await songs();
  const remote = before.find(s => !s.onLaptop);
  await q(`[...document.querySelectorAll('app-cloud-page .row')].find(r => r.textContent.includes(${JSON.stringify(remote.title)})).click()`);
  check('a cloud-only song plays', await page.waitFor(`document.querySelector('app-player-bar')?.textContent.includes(${JSON.stringify(remote.title)})`));
  let cached = false;
  for (let i = 0; i < 40 && !cached; i++) { await wait(500); cached = (await songs()).find(s => s.id === remote.id).onLaptop; }
  if (!cached) {
    const probe = await fetch(`${API}/cloud/songs/${remote.id}/stream`, { headers: { Range: 'bytes=0-9' } });
    console.log(`DIAG stream answer: ${probe.status} ${probe.status >= 400 ? await probe.text() : ''}`);
  }
  check('the player request fetched it into the cache', cached,
    `player: ${await q(`document.querySelector('app-player-bar')?.textContent.replace(/\s+/g, ' ').trim()`)}`);
  check('it is really playing (time moves)', await page.waitFor(`!/^0:00/.test(document.querySelector('app-player-bar .time, app-player-bar [class*=time]')?.textContent.trim() ?? '0:00')`, 10000),
    await q(`document.querySelector('app-player-bar')?.textContent.replace(/\s+/g, ' ').trim()`));
  await page.shot('cloud-4-playing');

  // Remove one song (two clicks)
  await click('app-cloud-page .action', 'Remove songs');
  await page.waitFor(`document.querySelectorAll('app-cloud-page .songs .song').length === 3`);
  await q(`document.querySelector('app-cloud-page .songs .song input').click()`);
  await click('app-cloud-page .action.danger', 'Delete 1');
  check('the first click only asks to confirm', (await songs()).length === 3);
  await click('app-cloud-page .action.danger', 'Click again');
  check('the second click deletes it', await page.waitFor(`document.querySelectorAll('app-cloud-page app-library-list .row').length === 2`));
  check('the cloud agrees', (await songs()).length === 2);

  // A song put in songs/ by hand (FileZilla) shows up; the list sorts by date and shows it.
  writeFileSync(join(ftp.root, 'music', 'songs', 'Hand Artist - Hand Song.mp3'), makeMp3({ title: 'Hand Song', artist: 'Hand Artist' }));
  await q(`location.href = ${JSON.stringify(APP)}`);
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 6`);
  await click('app-home .tile', 'Listen online');
  check('a song added by hand shows on the Cloud page', await page.waitFor(`document.querySelectorAll('app-cloud-page app-library-list .row').length === 3`)
    && (await q(`document.querySelector('app-cloud-page app-library-list').textContent.includes('Hand Song')`)));
  await q(`(() => { const s = document.querySelector('app-cloud-page select[aria-label="Sort the songs"]'); s.value = 'newest'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('"Newest first" puts it on top', await page.waitFor(`document.querySelector('app-cloud-page .row .title')?.textContent.trim() === 'Hand Song'`),
    await q(`document.querySelector('app-cloud-page .row .title')?.textContent.trim()`));
  await q(`(() => { const s = document.querySelector('app-cloud-page select[aria-label="Show songs added"]'); s.value = '7'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('"Last 7 days" keeps all 3 (all added today)', await page.waitFor(`document.querySelectorAll('app-cloud-page app-library-list .row').length === 3`));
  check('each row shows its date', (await q(`document.querySelectorAll('app-cloud-page .row .day').length`)) === 3);
  await page.shot('cloud-7-sorted');

  // The downloader offers "Also send to the cloud" now that the cloud is set up.
  await q(`location.href = ${JSON.stringify(APP)}`);
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 6`);
  await q(`[...document.querySelectorAll('app-home .tile')].find(t => /download/i.test(t.textContent)).click()`);
  check('the downloader shows "Also send to the cloud"', await page.waitFor(`document.querySelector('app-link-input .to-cloud')?.textContent.includes('Also send to the cloud')`));
  await page.shot('cloud-8-downloader');

  // Shared playlists: make one from a library song + a cloud-only song, share it.
  const cloudPlaylists = () => JSON.parse(readFileSync(join(ftp.root, 'music', 'playlists.json'), 'utf8')).playlists;
  await q(`location.href = ${JSON.stringify(APP)}`);
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 6`);
  await click('app-home .tile', 'Create playlist');
  await page.waitFor(`document.querySelectorAll('app-playlist-editor .song').length >= 2`);
  check('the editor lists cloud songs that are not on this laptop', (await q(`[...document.querySelectorAll('app-playlist-editor .tag')].map(t => t.textContent.trim())`)).includes('cloud'));
  await q(`(() => { const i = document.querySelector('app-playlist-editor .name'); i.value = 'Road trip'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await q(`document.querySelectorAll('app-playlist-editor .song input').forEach(i => i.click())`);
  const ticked = await q(`document.querySelectorAll('app-playlist-editor .song input:checked').length`);
  await q(`document.querySelector('app-playlist-editor .save').click()`);
  check('the new playlist holds every ticked song (library + cloud)', ticked >= 2
    && await page.waitFor(`document.querySelectorAll('app-playlist-page app-library-list .row').length === ${ticked}`), `${ticked} ticked`);
  check('the cloud song is marked "cloud"', (await q(`document.querySelectorAll('app-playlist-page .badge').length`)) >= 1);
  await q(`document.querySelector('app-playlist-page .share').click()`);
  check('the Shared switch turns on', await page.waitFor(`document.querySelector('app-playlist-page .share')?.getAttribute('aria-checked') === 'true'`));
  const mine = cloudPlaylists().find(p => p.name === 'Road trip');
  check('the playlist is on the cloud, owned by Tyler', mine?.owner === 'Tyler' && mine.songs.length === ticked, `${mine?.owner}, ${mine?.songs.length} songs`);
  await page.shot('cloud-5-shared-playlist');

  // Mum's laptop shares a playlist: one song she uploaded, one that is nowhere.
  const onCloud = (await songs())[0];
  writeFileSync(join(ftp.root, 'music', 'playlists.json'), JSON.stringify({ version: 1, playlists: [...cloudPlaylists(), {
    uid: 'u-mum', name: "Mum's mix", owner: 'Mum', updatedAt: Date.now(),
    songs: [{ title: onCloud.title, artist: onCloud.artist, album: onCloud.album, duration: onCloud.duration, isrc: null },
      { title: 'Lost Song', artist: 'Nobody', album: '', duration: 100, isrc: null }],
  }] }));
  await fetch(`${API}/cloud/playlists/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' });
  await q(`location.href = ${JSON.stringify(APP)}`);
  check("Mum's playlist shows on Home as from Mum", await page.waitFor(`[...document.querySelectorAll('app-home .tile')].some(t => t.textContent.includes("Mum's mix") && t.textContent.includes('from Mum'))`));
  check('my playlist shows as Shared', await page.waitFor(`[...document.querySelectorAll('app-home .tile')].some(t => t.textContent.includes('Road trip') && t.textContent.includes('Shared'))`));
  await click('app-home .tile', "Mum's mix");
  check('it opens with both songs', await page.waitFor(`document.querySelectorAll('app-playlist-page app-library-list .row').length === 2`));
  check('the song that is nowhere is greyed out', (await q(`document.querySelectorAll('app-playlist-page .row.unavailable').length`)) === 1);
  check('the page says who shared it', (await q(`document.querySelector('app-playlist-page .status')?.textContent`))?.includes('Shared by Mum'));
  await q(`document.querySelector('app-playlist-page .row:not(.unavailable)').click()`);
  check("a song of Mum's playlist plays", await page.waitFor(`document.querySelector('app-player-bar')?.textContent.includes(${JSON.stringify(onCloud.title)})`));
  await page.shot('cloud-6-mums-playlist');
} catch (e) {
  failed++;
  console.log(`FAIL  ${e.message}`);
  await page.shot('cloud-error');
} finally {
  await page.close(true);
  server.close();
  await ftp.close();
}
console.log(failed ? `${failed} check(s) failed` : 'All cloud UI checks passed');
process.exit(failed ? 1 : 0);
