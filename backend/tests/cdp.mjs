// Tiny Chrome DevTools Protocol helper (no dependencies) used by the demo/UI-check scripts.
// Opens the page in a VISIBLE Chrome window with its own profile; reuses that window if it is already running.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const wait = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9333;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const listPages = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

export async function openPage(appUrl, shotDir = join(tmpdir(), 'musehik-shots'), { width = 1000, height = 900 } = {}) {
  if (!CHROME) throw new Error('No Chrome/Edge found.');
  mkdirSync(shotDir, { recursive: true });

  let running = true;
  try { await listPages(); } catch { running = false; }

  let target;
  if (running) {
    // Chrome is already open (from an earlier run): open a brand-new tab and use exactly that one, so leftover
    // tabs and their playback state can never leak into this run.
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${appUrl}`, { method: 'PUT' })).json();
  } else {
    spawn(CHROME, [
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'musehik-chrome-profile')}`,
      '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, '--window-position=60,40',
      appUrl,
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60 && !target; i++) {
      await wait(500);
      try { target = (await listPages()).find(p => p.type === 'page' && p.url.startsWith(appUrl)); } catch { /* starting */ }
    }
  }
  if (!target) throw new Error('Could not attach to Chrome.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++nextId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Page.bringToFront'); // a background tab gets its timers and audio clock throttled

  /** Evaluates JS in the page. userGesture:true makes it count as a real click (needed for audio autoplay). */
  const evaluate = async expression =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log(`screenshot: ${file}`);
    return file;
  };
  /** Waits until a page-side condition becomes truthy. */
  const waitFor = async (expression, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await wait(250);
    }
    return false;
  };
  /** Disconnects. closeTab=true also closes the tab (used by automated checks; the demo leaves it open to watch). */
  const close = async (closeTab = false) => {
    ws.close();
    if (closeTab) await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
  };
  return { send, evaluate, shot, waitFor, close };
}
