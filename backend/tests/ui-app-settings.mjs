// Settings > Who uses this laptop and Settings > Music folder, in real Chrome.
// MuttMutt hides the AI tools (instrumental separator), Poontje shows them. Restores the profile it found.
// Needs the server (backend) and the app: APP=http://127.0.0.1:3100 to test the built app on another port.
import { openPage, wait } from './cdp.mjs';

const APP = process.env.APP || 'http://localhost:4200';
const API = process.env.API || (process.env.APP ? `${process.env.APP}/api` : 'http://127.0.0.1:3000/api');
const page = await openPage(APP, process.argv[2]);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const q = expr => page.evaluate(expr);
const tiles = () => q(`[...document.querySelectorAll('app-home .tile .name')].map(e => e.textContent.trim())`);
const goSettings = async () => { await q(`document.querySelector('.gear').click()`); await page.waitFor(`!!document.querySelector('app-settings')`); await wait(500); };
const goHome = async () => { await q(`history.back()`); await page.waitFor(`!!document.querySelector('app-home')`); await wait(500); };
const sectionTitles = () => q(`[...document.querySelectorAll('app-settings h2')].map(h => h.textContent.trim())`);
const choose = label => q(`[...document.querySelectorAll('app-settings [aria-label="Who uses this laptop"] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);

const original = (await (await fetch(`${API}/app`)).json()).profile;
await q('location.reload()');
await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 3`);
await wait(800);

try {
  await goSettings();
  const titles = await sectionTitles();
  check('settings has "Who uses this laptop?"', titles.includes('Who uses this laptop?'), titles.join(' | '));
  check('settings has "Music folder"', titles.includes('Music folder'), titles.join(' | '));
  const info = await (await fetch(`${API}/app`)).json();
  const shownPath = await q(`document.querySelector('app-settings .music-folder .label')?.textContent.trim()`);
  check('the music folder row shows the current folder', shownPath === info.musicDir, `${shownPath} vs ${info.musicDir}`);
  check('the music folder row has a Change button', await q(`[...document.querySelectorAll('app-settings .music-folder button')].some(b => b.textContent.includes('Change'))`));
  await page.shot('60-settings-profile');

  await choose('MuttMutt');
  await wait(600);
  check('MuttMutt is saved', (await (await fetch(`${API}/app`)).json()).profile === 'muttmutt');
  await goHome();
  check('MuttMutt: no separator tile on home', !(await tiles()).includes('Instrumental separator'), (await tiles()).join(' | '));
  await q(`(() => { const state = { view: { page: 'separate' }, depth: 1 }; history.pushState(state, ''); dispatchEvent(new PopStateEvent('popstate', { state })); })()`);
  await wait(500);
  check('MuttMutt: the separator page is not shown', !(await q(`!!document.querySelector('app-separator-page')`)));
  await page.shot('61-home-muttmutt');

  await goHome();
  await goSettings();
  await choose('Poontje');
  await wait(600);
  await goHome();
  check('Poontje: the separator tile is back', (await tiles()).includes('Instrumental separator'));
} finally {
  await fetch(`${API}/app/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: original }) });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
await page.close(true);
process.exit(failed ? 1 : 0);
