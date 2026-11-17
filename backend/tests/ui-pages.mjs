// Drives the page navigation in real Chrome: home tiles, all tracks, download page, creating / editing / deleting a
// playlist, browser Back. Creates a throw-away playlist named "ZZ UI test" and deletes it at the end.
// Needs the server (backend) and the Angular dev server (frontend) running.
import { openPage, wait } from './cdp.mjs';

const APP = process.env.APP || 'http://localhost:4200'; // APP=http://127.0.0.1:3000 to test the built app
const API = process.env.API || (process.env.APP ? `${process.env.APP}/api` : 'http://127.0.0.1:3000/api');
const page = await openPage(APP, process.argv[2]);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const q = expr => page.evaluate(expr);
const click = sel => q(`document.querySelector(${JSON.stringify(sel)}).click()`);
const tiles = () => q(`[...document.querySelectorAll('app-home .tile .name')].map(e => e.textContent.trim())`);
const heading = () => q(`document.querySelector('app-page-header h1')?.textContent.trim() ?? ''`);
const tile = name => q(`[...document.querySelectorAll('app-home .tile')].find(t => t.querySelector('.name').textContent.trim() === ${JSON.stringify(name)}).click()`);
const setValue = (sel, value) => q(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

// Clean up any leftover from an earlier failed run.
for (const p of await (await fetch(`${API}/playlists`)).json()) if (p.name.startsWith('ZZ UI test')) await fetch(`${API}/playlists/${p.id}`, { method: 'DELETE' });
await q('location.reload()');
await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`);
await wait(800);

// 1. Home: only tiles + the settings button, no song list and no download form.
const first = await tiles();
check('home shows the three fixed tiles', ['All tracks', 'Download new tracks', 'Create playlist'].every(n => first.includes(n)), first.join(' | '));
check('home has the settings button and no song list', (await q(`!!document.querySelector('.gear')`)) && (await q(`document.querySelectorAll('app-library-list').length`)) === 0);
check('the download form is not visible on home', await q(`document.querySelector('app-download-page').offsetParent === null`));
await page.shot('30-home-tiles');

// 2. All tracks page.
await tile('All tracks');
const expected = (await (await fetch(`${API}/library`)).json()).length;
await page.waitFor(`document.querySelectorAll('app-library-list .row').length > 0`);
check('All tracks lists every song', (await q(`document.querySelectorAll('app-library-list .row').length`)) === expected, `${expected} songs`);
check('All tracks has its title', (await heading()) === 'All tracks');
await page.shot('31-all-tracks');
await click('app-page-header .back');
check('the back arrow returns to the tiles', await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`));

// 3. Download page.
await tile('Download new tracks');
check('the download page shows the link form', await page.waitFor(`document.querySelector('app-download-page').offsetParent !== null && !!document.querySelector('app-link-input input')`));
await page.shot('32-download');
await q('history.back()');
check('the browser Back button returns home', await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`));

// 4. Create a playlist with two songs.
await tile('Create playlist');
await page.waitFor(`document.querySelectorAll('app-playlist-editor .song').length > 0`);
check('Save is disabled without a name', await q(`document.querySelector('app-playlist-editor .save').disabled`));
await setValue('app-playlist-editor .name', 'ZZ UI test');
await q(`document.querySelectorAll('app-playlist-editor .song input')[2].click()`);
await q(`document.querySelectorAll('app-playlist-editor .song input')[0].click()`);
await wait(200);
check('the editor counts 2 selected songs', (await q(`document.querySelector('app-playlist-editor .count').textContent`)).includes('2 selected'));
await page.shot('33-editor');
await click('app-playlist-editor .save');
check('saving opens the new playlist page', await page.waitFor(`document.querySelector('app-page-header h1')?.textContent.trim() === 'ZZ UI test'`));
await page.waitFor(`document.querySelectorAll('app-library-list .row').length > 0`);
check('the playlist page lists its 2 songs', (await q(`document.querySelectorAll('app-library-list .row').length`)) === 2);
await page.shot('34-playlist');

// 5. Clicking a song in the playlist makes the playlist the play queue (next goes to the other song, not the library's next).
const titles = await q(`[...document.querySelectorAll('app-library-list .row .title')].map(e => e.textContent.trim())`);
await click('app-library-list .row');
await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(titles[0])}`);
await click('app-player-bar .ctl[aria-label="Next track"]');
check('Next stays inside the playlist', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(titles[1])}`), titles.join(' -> '));
await q(`document.querySelector('app-player-bar .ctl.play').getAttribute('aria-label') === 'Pause' && document.querySelector('app-player-bar .ctl.play').click()`);

// 6. The playlist shows up as a tile; edit removes a song; then delete.
await click('app-page-header .back');
await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`);
await wait(300);
check('the playlist is now a tile with its count', (await q(`[...document.querySelectorAll('app-home .tile')].some(t => t.textContent.includes('ZZ UI test') && t.textContent.includes('2 songs'))`)));
await page.shot('35-home-with-playlist');
await tile('ZZ UI test');
await page.waitFor(`document.querySelector('app-page-header h1')?.textContent.trim() === 'ZZ UI test'`);
await q(`[...document.querySelectorAll('app-playlist-page .action')].find(b => b.textContent.trim() === 'Edit').click()`);
await page.waitFor(`document.querySelectorAll('app-playlist-editor .song input:checked').length === 2`);
check('editing starts with the saved songs ticked', true);
await q(`document.querySelector('app-playlist-editor .song input:checked').click()`);
await setValue('app-playlist-editor .name', 'ZZ UI test 2');
await click('app-playlist-editor .save');
await page.waitFor(`document.querySelector('app-page-header h1')?.textContent.trim() === 'ZZ UI test 2'`);
await page.waitFor(`document.querySelectorAll('app-library-list .row').length > 0`);
check('after editing: renamed and one song left', (await q(`document.querySelectorAll('app-library-list .row').length`)) === 1);
await q(`window.confirm = () => true`);
await q(`[...document.querySelectorAll('app-playlist-page .action')].find(b => b.textContent.trim() === 'Delete').click()`);
check('deleting returns home without the playlist', await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3 && ![...document.querySelectorAll('app-home .tile')].some(t => t.textContent.includes('ZZ UI test'))`));
check('the songs are still in the library', (await (await fetch(`${API}/library`)).json()).length === expected);

console.log(failed ? `${failed} checks FAILED` : 'All page checks passed.');
await page.close(true);
process.exit(failed ? 1 : 0);
