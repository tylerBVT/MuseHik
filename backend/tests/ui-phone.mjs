// Drives the PHONE's cloud screens in real Chrome (the app in phone mode, served by `ng serve` on port 4200) against
// a throw-away music API (PHP, temporary folder). Nothing real is touched. Saving songs on the phone needs the real
// Android app (native file storage), so it is checked on the device, not here.
//   cd frontend && npx ng serve      then      cd backend && node tests/ui-phone.mjs [screenshot folder]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPage, wait } from './cdp.mjs';
import { startCloud } from './cloud-fixture.mjs';
import { makeMp3 } from './mp3-fixture.mjs';

const APP = 'http://localhost:4200';
const tmp = mkdtempSync(join(tmpdir(), 'musehik-ui-phone-'));
const cloud = await startCloud();
const upload = async (title, artist, seconds = 2) => {
  const form = new FormData();
  form.append('file', new Blob([makeMp3({ title, artist, seconds })]), `${artist} - ${title}.mp3`);
  form.append('duration', String(seconds));
  form.append('addedBy', 'laptop');
  return (await cloud.api.call('POST', '/songs', { body: form })).json();
};
const alpha = await upload('Alpha', 'Band');
const beta = await upload('Beta', 'Band');
const cloudSongs = async () => (await (await cloud.api.call('GET', '/songs')).json()).songs;
const cloudPlaylists = async () => (await (await cloud.api.call('GET', '/playlists')).json()).playlists;

const page = await openPage(APP, process.argv[2], { width: 420, height: 900 });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const q = expr => page.evaluate(expr);
const text = selector => q(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
const click = (selector, label) => q(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(label)}));
  if (!el) return false; el.click(); return true;
})()`);
const typeInField = (label, value) => q(`(() => {
  const field = [...document.querySelectorAll('app-settings .field')].find(f => f.querySelector('.label').textContent.trim() === ${JSON.stringify(label)});
  const input = field.querySelector('input'); input.value = ${JSON.stringify(String(value))};
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
/** Opens the home tile whose name is exactly `name`. */
const tile = name => q(`(() => {
  const el = [...document.querySelectorAll('app-home .tile')].find(t => t.querySelector('.name').textContent.trim() === ${JSON.stringify(name)});
  if (!el) return false; el.click(); return true;
})()`);
const home = async () => {
  await q(`location.href = ${JSON.stringify(APP)}`);
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 5`);
};

try {
  // Phone mode, from a clean phone.
  await page.waitFor(`document.readyState === 'complete'`);
  await q(`['musehik.cloud', 'musehik.saved', 'musehik.lastSongs'].forEach(k => localStorage.removeItem(k)); localStorage.setItem('musehik.phoneMode', '1'); location.reload()`);
  await wait(500);
  await page.waitFor(`document.querySelectorAll('app-home .tile').length >= 5`);
  const tiles = await q(`[...document.querySelectorAll('app-home .tile .name')].map(e => e.textContent.trim())`);
  check('phone home has the cloud tiles', ['All tracks', 'Create playlist', 'Cloud upload', 'Cloud', 'Download from cloud'].every(t => tiles.includes(t)), tiles.join(' | '));
  check('phone home has no downloader or separator', !tiles.includes('Download new tracks') && !tiles.includes('Download to cloud') && !tiles.includes('Instrumental separator'));
  await page.shot('phone-1-home');

  // Settings: address, key, name, then Save and test.
  await q(`document.querySelector('app-root .gear').click()`);
  await page.waitFor(`document.querySelector('app-settings .field')`);
  check('settings show the cloud section and no laptop-only sections',
    await q(`!!document.querySelector('#cloud') && !document.querySelector('#engine') && !document.querySelector('#music-folder')`));
  await typeInField('Address', cloud.settings.url);
  await typeInField('Key', cloud.settings.key);
  await typeInField('Your name', 'Test phone');
  await click('app-settings button', 'Save and test');
  check('save and test connects', await page.waitFor(`document.querySelector('app-settings [role=status]')?.textContent.includes('Connected')`),
    await text('app-settings [role=status]'));
  check('the key is not shown again', await q(`[...document.querySelectorAll('app-settings input[type=password]')].every(i => i.value === '')`));
  await page.shot('phone-2-settings');

  // Cloud page: the list, the storage bar, playing straight from the cloud.
  await home();
  await tile('Cloud');
  check('the cloud lists its songs', await page.waitFor(`document.querySelectorAll('app-cloud-page .row').length === 2`));
  check('the storage bar shows the usage', await page.waitFor(`/of 30 GB/.test(document.querySelector('app-cloud-usage')?.textContent ?? '')`),
    (await text('app-cloud-usage')).trim().slice(0, 80));
  const readsBefore = cloud.reads.length;
  await click('app-cloud-page .row', 'Alpha');
  check('a cloud song plays straight from the cloud (with the key)', await page.waitFor(`document.querySelector('app-player-bar')?.textContent.includes('Alpha')`)
    && await (async () => { for (let i = 0; i < 40 && cloud.reads.length === readsBefore; i++) await wait(250); return cloud.reads.length > readsBefore; })());
  await page.shot('phone-3-cloud');
  await click('app-player-bar button', ''); // pause/stop any playback noise is not checked

  // Rename from the song menu.
  await q(`[...document.querySelectorAll('app-cloud-page li')].find(li => li.textContent.includes('Beta')).querySelector('.more').click()`);
  await page.waitFor(`document.querySelector('app-song-menu dialog[open]')`);
  check('the song menu offers saving to this phone', (await text('app-song-menu dialog')).includes('Save to this phone'));
  await q(`(() => { const i = document.querySelector('app-song-menu input[name=title]'); i.value = 'Beta two'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('app-song-menu button', 'Save');
  await wait(800);
  check('the rename reaches the cloud', (await cloudSongs()).some(s => s.id === beta.id && s.title === 'Beta two' && s.file === 'Band - Beta two.mp3'));
  await q(`document.querySelector('app-song-menu dialog')?.close()`);

  // Upload two files picked on the phone (one is already on the cloud).
  await home();
  await tile('Cloud upload');
  await page.waitFor(`document.querySelector('app-cloud-upload-page input[type=file]')`);
  check('the upload page has no laptop tabs', await q(`!document.querySelector('app-cloud-upload-page .tabs')`));
  const fresh = join(tmp, 'track01.mp3');
  writeFileSync(fresh, makeMp3({ title: 'From phone', artist: 'Phone Band', seconds: 3 }));
  const twin = join(tmp, 'Band - Alpha.mp3');
  writeFileSync(twin, makeMp3({ title: 'Alpha', artist: 'Band', seconds: 2 }));
  const { result: { root } } = await page.send('DOM.getDocument', {});
  const { result: { nodeId } } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'app-cloud-upload-page input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: [fresh, twin] });
  check('the picked files are listed and ticked', await page.waitFor(`document.querySelectorAll('app-cloud-upload-page .song input:checked').length === 2`));
  check('the picked files show their tags, not their file names', await page.waitFor(`[...document.querySelectorAll('app-cloud-upload-page .song')].some(r => r.textContent.includes('From phone') && r.textContent.includes('Phone Band'))`, 5000),
    (await text('app-cloud-upload-page .songs')).replace(/s+/g, ' ').trim());
  await click('app-cloud-upload-page button', 'Upload');
  check('the upload finishes', await page.waitFor(`document.querySelector('app-cloud-upload-page .progress')?.textContent.includes('Upload finished')`, 30000),
    (await text('app-cloud-upload-page .summary')).trim());
  check('one uploaded, one already on the cloud', (await text('app-cloud-upload-page .summary')).includes('1 uploaded · 1 already on the cloud'));
  const sent = (await cloudSongs()).find(s => s.title === 'From phone');
  check('the tags were read on the phone (title, artist, length) and the sender is the phone', sent?.artist === 'Phone Band' && sent.addedBy === 'Test phone' && sent.duration > 2,
    JSON.stringify(sent && { title: sent.title, artist: sent.artist, duration: sent.duration, addedBy: sent.addedBy }));
  await page.shot('phone-4-upload');

  // A playlist made on the phone: on the cloud, owned by the phone.
  await home();
  await tile('Create playlist');
  await page.waitFor(`document.querySelectorAll('app-playlist-editor .song').length >= 3`);
  check('the editor lists cloud songs once each', await q(`document.querySelectorAll('app-playlist-editor .song').length`) === 3);
  await q(`(() => { const i = document.querySelector('app-playlist-editor .field input'); i.value = 'Phone mix'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await q(`[...document.querySelectorAll('app-playlist-editor .song')].filter(s => /Alpha|From phone/.test(s.textContent)).forEach(s => s.querySelector('input').click())`);
  await click('app-playlist-editor button', 'Save');
  check('the playlist page opens with its songs', await page.waitFor(`document.querySelectorAll('app-playlist-page .row').length === 2`));
  check('no share switch on the phone', await q(`!document.querySelector('app-playlist-page .share')`));
  const [made] = await cloudPlaylists();
  check('the playlist is on the cloud, owned by the phone', made?.name === 'Phone mix' && made.owner === 'Test phone' && made.songs.every(s => s.songId),
    JSON.stringify(made && { name: made.name, owner: made.owner }));
  await home();
  check('home shows the playlist', await page.waitFor(`[...document.querySelectorAll('app-home .tile .name')].some(e => e.textContent.trim() === 'Phone mix')`));
  await tile('Phone mix');
  await page.waitFor(`document.querySelectorAll('app-playlist-page .row').length === 2`);
  await q(`window.confirm = () => true`);
  await click('app-playlist-page button', 'Delete');
  await wait(800);
  check('deleting it removes it from the cloud', (await cloudPlaylists()).length === 0);

  // Delete from the cloud (two clicks).
  await home();
  await tile('Cloud');
  await page.waitFor(`document.querySelectorAll('app-cloud-page .row').length === 3`);
  await q(`[...document.querySelectorAll('app-cloud-page li')].find(li => li.textContent.includes('From phone')).querySelector('.more').click()`);
  await page.waitFor(`document.querySelector('app-song-menu dialog[open]')`);
  await click('app-song-menu button', 'Delete from the cloud');
  await click('app-song-menu button', 'Click again');
  await wait(800);
  check('the song is deleted from the cloud', !(await cloudSongs()).some(s => s.title === 'From phone'));
  await q(`document.querySelector('app-song-menu dialog')?.close()`);

  // Offline: the last list seen, without connecting.
  await q(`document.querySelector('app-root .gear')?.click() ?? (location.href = ${JSON.stringify(APP)})`);
  await home();
  await q(`document.querySelector('app-root .gear').click()`);
  await page.waitFor(`document.querySelector('app-settings input[role=switch]')`);
  await q(`document.querySelector('app-settings input[role=switch]').click()`);
  await wait(300);
  const before = cloud.requests;
  await home();
  await tile('Cloud');
  check('switched off: the last list, said plainly', await page.waitFor(`document.querySelector('app-cloud-page')?.textContent.includes('offline on this phone')`));
  check('switched off: nothing is sent to the cloud', cloud.requests === before, `${cloud.requests - before} requests`);
  await page.shot('phone-5-offline');
} catch (e) {
  failed++;
  console.log('FAIL  crashed:', e.message);
} finally {
  await q(`['musehik.phoneMode', 'musehik.cloud', 'musehik.saved', 'musehik.lastSongs'].forEach(k => localStorage.removeItem(k))`).catch(() => {});
  await page.close(true);
  await cloud.close();
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll phone UI checks passed.');
process.exit(failed ? 1 : 0);
