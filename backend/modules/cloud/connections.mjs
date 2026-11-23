// The two FTP connections ("lanes") this laptop keeps to the cloud, each opened at its first use and then reused:
//   listen    playing songs, the song list, playlists, renames and deletes: a click never waits behind a transfer
//   transfer  uploads and saving songs to this laptop, one after another; opened only while there is such work
// A lane closes after some time without use. While open and idle, a NOOP now and then keeps the server from dropping it;
// if it was dropped anyway, the next call reconnects (remote.mjs). After a long silence (laptop asleep) the lane is
// checked first, so a dead connection costs a short wait instead of a 30 s timeout.
import { openSession } from './remote.mjs';

const DEFAULT_TIMINGS = Object.freeze({
  idle: { listen: 15 * 60_000, transfer: 2 * 60_000 },
  keepalive: 60_000,
  stale: 90_000,
  pingTimeout: 3_000,
});
let timings = DEFAULT_TIMINGS;

/** For tests: shorter times (missing fields keep their default). No argument = back to the defaults. */
export function setTimings(partial = {}) {
  timings = { ...DEFAULT_TIMINGS, ...partial, idle: { ...DEFAULT_TIMINGS.idle, ...partial.idle } };
}

const lanes = new Map(); // name -> { key, opening: Promise<session>, users, idleTimer, pingTimer }

/** The settings that make a connection: another value means another connection. */
const keyOf = s => JSON.stringify([s.host, s.port, s.user, s.password, s.folder, Boolean(s.allowPlainFtp)]);

async function shut(name, lane) {
  if (lanes.get(name) === lane) lanes.delete(name);
  clearTimeout(lane.idleTimer);
  clearInterval(lane.pingTimer);
  try { await (await lane.opening).close(); } catch { /* it never opened, or is already gone */ }
}

function open(name, settings) {
  const lane = { key: keyOf(settings), users: 0, idleTimer: null, pingTimer: null };
  lane.opening = openSession(settings);
  lanes.set(name, lane);
  lane.opening.then(session => {
    lane.pingTimer = setInterval(() => {
      if (!lane.users) session.ping(timings.pingTimeout).catch(() => { /* the next call reconnects */ });
    }, timings.keepalive);
    lane.pingTimer.unref?.();
  }, () => { if (lanes.get(name) === lane) lanes.delete(name); }); // a failed login is retried by the next call
  return lane;
}

/** Lane `name` ('listen' or 'transfer'), opened if needed: { session, release }. Call release() when done with it. */
export async function borrow(name, settings) {
  let lane = lanes.get(name);
  if (lane && lane.key !== keyOf(settings)) {
    void shut(name, lane);
    lane = null;
  }
  lane ??= open(name, settings);
  lane.users++;
  clearTimeout(lane.idleTimer);
  try {
    const session = await lane.opening;
    if (Date.now() - session.lastOk >= timings.stale) await session.ping(timings.pingTimeout).catch(() => {});
    let released = false;
    return { session, release: () => { if (!released) { released = true; release(name, lane); } } };
  } catch (e) {
    release(name, lane);
    throw e;
  }
}

/** Done with the lane for now: it closes after its idle time unless borrowed again. */
function release(name, lane) {
  lane.users = Math.max(0, lane.users - 1);
  if (lane.users) return;
  clearTimeout(lane.idleTimer);
  if (lanes.get(name) !== lane) return; // replaced (new settings): already closing
  lane.idleTimer = setTimeout(() => { if (!lane.users) void shut(name, lane); }, timings.idle[name] ?? timings.idle.listen);
  lane.idleTimer.unref?.();
}

/** Names of the lanes open now. */
export const openLanes = () => [...lanes.keys()];

/** Closes every lane (settings changed, tests, shutdown). */
export async function closeLanes() {
  await Promise.all([...lanes].map(([name, lane]) => shut(name, lane)));
}
