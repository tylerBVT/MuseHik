// Drives the Instrumental separator page in real Chrome: home tile, search filter, playlist scope, single selection,
// the three methods, a real separation with its progress bar, playing and downloading the result, and Stop.
// Needs the server running and the separator installed (MuseHikData/separator-venv + models; GPU recommended).
//   APP=http://127.0.0.1:3000 tests the built app.  SEP_METHOD=fast|best|backing (default fast).
//   SEP_TRACK=<exact title> picks the song (default: the shortest song of the library).
import { openPage, wait } from './cdp.mjs';

const APP = process.env.APP || 'http://localhost:4200';
const API = process.env.API || (process.env.APP ? `${process.env.APP}/api` : 'http://127.0.0.1:3000/api');
const page = await openPage(APP, process.argv[2]);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const q = expr => page.evaluate(expr);
const P = 'app-separator-page';
const rows = () => q(`document.querySelectorAll('${P} .song').length`);
const button = () => q(`document.querySelector('${P} .go').disabled`);
const setValue = (sel, value, event = 'input') => q(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('${event}', { bubbles: true })); })()`);
const pickSong = async title => {
  await setValue(`${P} .search`, title);
  await page.waitFor(`[...document.querySelectorAll('${P} .song .title')].some(e => e.textContent.trim() === ${JSON.stringify(title)})`);
  await q(`[...document.querySelectorAll('${P} .song')].find(s => s.querySelector('.title').textContent.trim() === ${JSON.stringify(title)}).querySelector('input').click()`);
  await wait(300);
};

const library = await (await fetch(`${API}/library`)).json();
await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`);
const tiles = await q(`[...document.querySelectorAll('app-home .tile .name')].map(e => e.textContent.trim())`);
check('home has the Instrumental separator tile right after Download', tiles.indexOf('Instrumental separator') === tiles.indexOf('Download new tracks') + 1, tiles.join(' | '));

await q(`[...document.querySelectorAll('app-home .tile')].find(t => t.textContent.includes('Instrumental separator')).click()`);
check('the page opens with its title', await page.waitFor(`document.querySelector('app-page-header h1')?.textContent.trim() === 'Instrumental separator'`));
check('the intro sentence is shown', (await q(`document.querySelector('${P} .intro').textContent`)).includes('extract the instrumental'));
await page.waitFor(`document.querySelectorAll('${P} .song').length > 0`);
check('All songs lists the whole library', (await rows()) === library.length, `${library.length} songs`);
check('Get instrumental is disabled with no song selected', await button());
await page.waitFor(`document.querySelectorAll('${P} .method').length === 3`);
const methods = await q(`[...document.querySelectorAll('${P} .method-name')].map(e => e.childNodes[0].textContent.trim())`);
check('the three methods are offered', ['Fast', 'Best quality', 'Keep backing vocals'].every(m => methods.includes(m)), methods.join(' | '));
await page.shot('41-separator-empty');

const target = library[3];
await setValue(`${P} .search`, target.title.split(/\s+/)[0]);
await wait(200);
const filtered = await rows();
check('typing filters the list by name', filtered >= 1 && filtered < library.length, `${filtered} left for "${target.title.split(/\s+/)[0]}"`);
await pickSong(target.title);
check('selecting a song shows it above the list', (await q(`document.querySelector('${P} .chosen .title')?.textContent.trim()`)) === target.title);
check('Get instrumental becomes enabled', !(await button()));

const playlists = await (await fetch(`${API}/playlists`)).json();
const playlist = playlists.find(p => p.count > 0);
if (playlist) {
  await setValue(`${P} .search`, '');
  await setValue(`${P} .scope`, String(playlist.id), 'change');
  await page.waitFor(`document.querySelectorAll('${P} .song').length === ${playlist.count}`);
  check('choosing a playlist lists only its songs', (await rows()) === playlist.count, `${playlist.name}: ${playlist.count}`);
  await setValue(`${P} .scope`, 'all', 'change');
} else console.log('SKIP  no playlist with songs to test the scope');

// ---- a real separation
const song = process.env.SEP_TRACK ? library.find(t => t.title === process.env.SEP_TRACK) : [...library].sort((a, b) => a.duration - b.duration)[0];
const method = process.env.SEP_METHOD || 'fast';
await fetch(`${API}/separator/tracks/${song.id}/${method}`, { method: 'DELETE' }); // start from scratch
await fetch(`${API}/separator/tracks/${song.id}/backing`, { method: 'DELETE' });
await pickSong(song.title);
await q(`document.querySelector('${P} .method input[value=${method}]').click()`);
await wait(300);
console.log(`      separating "${song.artist} - ${song.title}" (${Math.round(song.duration)} s) with ${method} ...`);
const t0 = Date.now();
await q(`document.querySelector('${P} .go').click()`);
check('a progress bar appears', await page.waitFor(`!!document.querySelector('${P} .progress .fill')`, 15000));
check('the button is disabled while it runs', await button());
let stage = '';
for (let i = 0; i < 60 && !stage.includes('Step'); i++) { await wait(1000); stage = await q(`document.querySelector('${P} .stage')?.textContent ?? ''`); }
check('the progress shows the current step', stage.includes('Step'), stage.trim());
await page.shot('44-separator-running');
const done = await page.waitFor(`document.querySelectorAll('${P} .result audio').length >= 2 || !!document.querySelector('${P} .error')`, 20 * 60000);
const error = await q(`document.querySelector('${P} .error')?.textContent ?? ''`);
check('the instrumental appears when done', done && !error, error || `${Math.round((Date.now() - t0) / 1000)} s`);
if (!error) {
  const src = await q(`document.querySelectorAll('${P} .result audio')[1].src`);
  const ranged = await fetch(src, { headers: { Range: 'bytes=0-99' } });
  check('the result streams with seeking (206, audio/mpeg)', ranged.status === 206 && ranged.headers.get('content-type') === 'audio/mpeg');
  await ranged.body?.cancel();
  const download = await fetch(await q(`document.querySelector('${P} .result a[download]').href`));
  check('Download gives an MP3 attachment', /attachment/.test(download.headers.get('content-disposition') || ''), decodeURIComponent(download.headers.get('content-disposition') || ''));
  await download.body?.cancel();
  await q(`document.querySelectorAll('${P} .result audio')[1].play()`);
  await wait(2000);
  check('the result really plays in the browser', await q(`document.querySelectorAll('${P} .result audio')[1].currentTime > 0.3`));
  await q(`document.querySelectorAll('${P} .result audio')[1].pause()`);
  check('the button now says "Make it again"', (await q(`document.querySelector('${P} .go').textContent.trim()`)) === 'Make it again');
  await page.shot('45-separator-done');
}

// ---- Stop
await q(`document.querySelector('${P} .method input[value=backing]').click()`);
await wait(300);
await q(`document.querySelector('${P} .go').click()`);
await page.waitFor(`!!document.querySelector('${P} .progress .stop')`, 15000);
await wait(5000);
await q(`document.querySelector('${P} .progress .stop').click()`);
check('Stop removes the progress bar', await page.waitFor(`!document.querySelector('${P} .progress')`, 10000));
await wait(2000);
const after = await (await fetch(`${API}/separator/tracks/${song.id}`)).json();
check('a stopped job leaves no file and no running job', !after.job && !after.results.some(r => r.method === 'backing'), JSON.stringify(after));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
await page.close?.();
process.exit(failed ? 1 : 0);
