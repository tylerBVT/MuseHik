// Opens the app in a VISIBLE Chrome window, pastes a link, clicks Download and logs what the page shows.
// Chrome stays open when this script ends. Usage: node demo-ui.mjs <link> [screenshotDir] [maxMinutes]
import { openPage, wait } from './cdp.mjs';

const link = process.argv[2];
const maxMs = Number(process.argv[4] || 60) * 60000;
if (!link) { console.log('Usage: node demo-ui.mjs <link> [screenshotDir] [maxMinutes]'); process.exit(2); }

const page = await openPage('http://localhost:4200', process.argv[3]);
await page.waitFor(`document.querySelector('app-link-input input')`);
await page.shot('20-empty-page');

// Paste the link the way a user would: same 'input' event as real typing.
await page.evaluate(`(() => {
  const input = document.querySelector('app-link-input input');
  input.focus();
  input.value = ${JSON.stringify(link)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(600);
console.log('download button enabled after paste?', !(await page.evaluate(`document.querySelector('app-link-input button').disabled`)));
await page.evaluate(`document.querySelector('app-link-input button').click()`);
console.log('clicked Download');

const readPanel = () => page.evaluate(`JSON.stringify((() => {
  const q = s => document.querySelector(s)?.textContent.trim().replace(/\\s+/g, ' ') ?? '';
  return { title: q('.progress-head .title'), count: q('.progress-head .count'), percent: q('.progress-foot .percent'),
    current: q('.progress-foot .current'), summary: q('.summary-line'), toast: q('.toast') };
})())`);

const started = Date.now();
let lastShot = 0, shots = 0, last = '';
while (Date.now() - started < maxMs) {
  await wait(3000);
  const panel = JSON.parse((await readPanel()) || '{}');
  if (panel.summary || panel.toast) {
    console.log('FINISHED:', panel.summary, '|', panel.toast);
    // Open the expandable lists so the screenshot shows them.
    await page.evaluate(`document.querySelectorAll('.summary details').forEach(d => d.open = true)`);
    await wait(400);
    await page.shot('22-finished');
    break;
  }
  const line = `${panel.title} | ${panel.count} | ${panel.percent} | ${panel.current}`;
  if (line !== last && panel.title) { console.log(new Date().toLocaleTimeString(), line); last = line; }
  if (Date.now() - lastShot > 60000 && panel.title) { await page.shot(`21-progress-${String(++shots).padStart(2, '0')}`); lastShot = Date.now(); }
}
page.close();
