// Drives the real UI in Chrome and checks the player works: library list, search, play, seek, pause,
// next/previous. Needs the server (backend) and the Angular dev server (frontend) running.
// Usage: node ui-check.mjs [screenshotDir]
import { openPage, wait } from './cdp.mjs';

const APP = process.env.APP || 'http://localhost:4200'; // APP=http://127.0.0.1:3000 to test the built app
const API = process.env.API || (process.env.APP ? `${process.env.APP}/api` : 'http://127.0.0.1:3000/api');
const page = await openPage(APP, process.argv[2]);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const text = sel => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim().replace(/\\s+/g, ' ') ?? ''`);
const count = sel => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const clock = async () => { // seconds shown in the player bar
  const t = await page.evaluate(`document.querySelector('app-player-bar .seek .time')?.textContent.trim() ?? ''`);
  const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
};

// 1. The song list lives on the "All tracks" page; open it from the home tiles.
await page.waitFor(`document.querySelectorAll('app-home .tile').length > 0`);
await page.evaluate(`[...document.querySelectorAll('app-home .tile')].find(t => t.textContent.includes('All tracks')).click()`);
const expected = (await (await fetch(`${API}/library`)).json()).length;
await page.waitFor(`document.querySelectorAll('app-library-list .row').length > 0`);
await wait(1500);
check('library lists all songs from the server', (await count('app-library-list .row')) === expected, `${await count('app-library-list .row')} rows, server has ${expected}`);
check('player bar hidden before anything plays', (await count('app-player-bar .bar')) === 0);
await page.shot('10-library');

// 2. Search filters the list.
const setSearch = value => page.evaluate(`(() => { const i = document.querySelector('app-library-list .search'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await setSearch('daft');
await wait(400);
const filtered = await count('app-library-list .row');
check('search narrows the list', filtered > 0 && filtered < expected, `${filtered} rows for "daft"`);
await page.shot('11-search');
await setSearch('');
await wait(400);

// 3. Play the first song with a click.
const firstTitle = await text('app-library-list .row .title');
await page.evaluate(`document.querySelector('app-library-list .row').click()`);
check('player bar appears with the clicked song', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(firstTitle)}`), firstTitle);
const playing = await page.waitFor(`document.querySelector('app-player-bar .ctl.play')?.getAttribute('aria-label') === 'Pause'`);
check('shows Pause while playing', playing);
await page.waitFor(`/^0:0[1-9]|^0:[1-5]/.test(document.querySelector('app-player-bar .seek .time')?.textContent.trim() ?? '')`, 15000); // first stream can start slowly
await wait(1500);
const t1 = await clock();
await wait(2000);
const t2 = await clock();
check('the clock advances (audio is really playing)', t2 > t1 && t1 >= 2, `${t1}s -> ${t2}s`);
await page.shot('12-playing');

// 4. Seek forward by moving the slider.
await page.evaluate(`(() => { const s = document.querySelector('app-player-bar .seek input'); s.value = 100; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await wait(2500);
const afterSeek = await clock();
check('seeking jumps to the new position', afterSeek >= 100 && afterSeek < 110, `${afterSeek}s`);

// 5. Pause stops the clock; play resumes it.
await page.evaluate(`document.querySelector('app-player-bar .ctl.play').click()`);
await wait(800);
const p1 = await clock();
await wait(2000);
const p2 = await clock();
check('pause freezes the clock', p1 === p2, `${p1}s / ${p2}s`);
check('shows Play while paused', (await page.evaluate(`document.querySelector('app-player-bar .ctl.play').getAttribute('aria-label')`)) === 'Play');
await page.evaluate(`document.querySelector('app-player-bar .ctl.play').click()`);

// 6. Next goes to the following song in the list; previous restarts or goes back.
const secondTitle = await page.evaluate(`document.querySelectorAll('app-library-list .row .title')[1].textContent.trim()`);
await page.evaluate(`document.querySelector('app-player-bar .ctl[aria-label="Next track"]').click()`);
check('next plays the following song', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(secondTitle)}`), secondTitle);
await wait(4500); // > 3 s in: previous should restart the song
await page.evaluate(`document.querySelector('app-player-bar .ctl[aria-label="Previous track"]').click()`);
await wait(800);
check('previous (after 3 s) restarts the current song', (await clock()) <= 2 && (await text('app-player-bar .bar .title')) === secondTitle, `${await clock()}s`);
await page.evaluate(`document.querySelector('app-player-bar .ctl[aria-label="Previous track"]').click()`);
check('previous (at the start) goes back a song', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(firstTitle)}`), firstTitle);

// 7. Volume slider moves.
await page.evaluate(`(() => { const s = document.querySelector('app-player-bar .volume input'); s.value = 0.3; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await wait(300);
check('volume slider keeps its value', Number(await page.evaluate(`document.querySelector('app-player-bar .volume input').value`)) === 0.3);
await page.shot('13-final');

// 8. Repeat and shuffle with real songs ending by themselves (seek to 2 s before the end and let the clock run out).
const click = sel => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const attr = (sel, name) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).getAttribute(${JSON.stringify(name)})`);
const nowTitle = () => text('app-player-bar .bar .title');
const seekNearEnd = () => page.evaluate(`(() => { const s = document.querySelector('app-player-bar .seek input'); s.value = Number(s.max) - 2; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const listTitles = () => page.evaluate(`[...document.querySelectorAll('app-library-list .row .title')].map(e => e.textContent.trim())`);

check('repeat starts off, shuffle starts off', (await attr('.repeat', 'aria-label')) === 'Repeat: off' && (await attr('.shuffle', 'aria-pressed')) === 'false');
await page.shot('14-buttons-off');

// Repeat off: the song ends and the next one in the list plays by itself.
const list = await listTitles();
const startTitle = await nowTitle();
const nextInList = list[list.indexOf(startTitle) + 1];
await seekNearEnd();
check('repeat off: a finished song is followed by the next one', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() === ${JSON.stringify(nextInList)}`, 15000), `${startTitle} -> ${nextInList}`);
check('...and it keeps playing', (await attr('app-player-bar .ctl.play', 'aria-label')) === 'Pause');

// The repeat button cycles off -> all -> one.
await click('.repeat');
check('repeat button -> all', (await attr('.repeat', 'aria-label')) === 'Repeat: all' && (await attr('.repeat', 'aria-pressed')) === 'true');
await click('.repeat');
check('repeat button -> one (shows a "1")', (await attr('.repeat', 'aria-label')) === 'Repeat: one' && (await count('.repeat svg text')) === 1);
await page.shot('15-repeat-one');

// Repeat one: the finished song plays again; Next still moves on.
const repeatTitle = await nowTitle();
await seekNearEnd();
await wait(4500);
check('repeat one: the song plays again after it ends', (await nowTitle()) === repeatTitle && (await clock()) <= 4, `${repeatTitle}, clock ${await clock()}s`);
check('repeat one: still playing', (await attr('app-player-bar .ctl.play', 'aria-label')) === 'Pause');
await click('app-player-bar .ctl[aria-label="Next track"]');
check('repeat one: the Next button still moves on', await page.waitFor(`document.querySelector('app-player-bar .bar .title')?.textContent.trim() !== ${JSON.stringify(repeatTitle)}`));
await click('.repeat');
check('repeat button -> off', (await attr('.repeat', 'aria-label')) === 'Repeat: off' && (await attr('.repeat', 'aria-pressed')) === 'false');

// Shuffle: keeps the current song, then visits songs in a random order without repeating.
const beforeShuffle = await nowTitle();
await click('.shuffle');
check('shuffle on: lights up and the current song keeps playing', (await attr('.shuffle', 'aria-pressed')) === 'true' && (await nowTitle()) === beforeShuffle);
const visited = [beforeShuffle];
for (let i = 0; i < 6; i++) {
  await click('app-player-bar .ctl[aria-label="Next track"]');
  await wait(350);
  visited.push(await nowTitle());
}
const startIndex = list.indexOf(beforeShuffle);
const inListOrder = list.slice(startIndex, startIndex + visited.length);
check('shuffle: no song repeats within the pass', new Set(visited).size === visited.length, visited.join(' | '));
check('shuffle: the order is not the list order', visited.join('|') !== inListOrder.join('|'));
await page.shot('16-shuffle-on');
await click('.shuffle');
check('shuffle off again: list order resumes from the current song', await (async () => {
  const cur = await nowTitle();
  await click('app-player-bar .ctl[aria-label="Next track"]');
  await wait(500);
  return (await nowTitle()) === list[list.indexOf(cur) + 1];
})());
check('shuffle button shows off', (await attr('.shuffle', 'aria-pressed')) === 'false');

// Leave the music paused when done.
const label = await page.evaluate(`document.querySelector('app-player-bar .ctl.play').getAttribute('aria-label')`);
if (label === 'Pause') await page.evaluate(`document.querySelector('app-player-bar .ctl.play').click()`);

const failed = results.filter(r => !r).length;
console.log(failed ? `${failed} of ${results.length} checks FAILED` : `All ${results.length} checks passed.`);
await page.close(true);
process.exit(failed ? 1 : 0);
