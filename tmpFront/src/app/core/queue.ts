/**
 * Pure "what plays next" rules (no audio, no Angular), so they can be unit-tested.
 *
 * The queue itself (the library list) is never reordered. A separate `order` array says in which order its items play:
 * it is the identity [0, 1, 2, ...] normally, and a random permutation while shuffle is on. `position` is where we are in
 * `order`. Behaviour follows Spotify/Deezer and, for the edge cases, what Feishin does (reimplemented, not copied).
 */

export type RepeatMode = 'off' | 'all' | 'one';

export type Random = () => number;

/** [0, 1, 2, ..., length-1] */
export function identityOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/** Fisher–Yates in place. */
function shuffleInPlace<T>(items: T[], random: Random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * A random play order that starts with `first` (the song already playing, so nothing jumps). Every other song appears
 * exactly once, so a full pass plays each song once before any repeats. `first = -1` shuffles everything.
 */
export function shuffledOrder(length: number, first = -1, random: Random = Math.random): number[] {
  const rest = identityOrder(length).filter((i) => i !== first);
  shuffleInPlace(rest, random);
  return first >= 0 && first < length ? [first, ...rest] : rest;
}

/** A fresh shuffled pass that does not begin with the song that just finished (unless it is the only one). */
export function reshuffledOrder(length: number, last: number, random: Random = Math.random): number[] {
  const order = shuffledOrder(length, -1, random);
  if (length > 1 && order[0] === last) {
    const j = 1 + Math.floor(random() * (length - 1));
    [order[0], order[j]] = [order[j], order[0]];
  }
  return order;
}

export interface Step {
  /** Position in `order` to go to. */
  position: number;
  /** True when playback should stop there (end of the queue with repeat off). */
  stop: boolean;
  /** True when we passed the end of the queue and came back to the start. */
  wrapped: boolean;
}

/**
 * The next position. `ended` is true when the song finished by itself, false for the Next button.
 * - repeat one + ended: stay on the same song.
 * - last song: repeat all carries on from the first; repeat off stops *and returns to the first song* (paused).
 */
export function advance(position: number, length: number, repeat: RepeatMode, ended: boolean): Step {
  if (length <= 0) return { position: 0, stop: true, wrapped: false };
  if (ended && repeat === 'one') return { position, stop: false, wrapped: false };
  if (position < length - 1) return { position: position + 1, stop: false, wrapped: false };
  return { position: 0, stop: repeat !== 'all', wrapped: true };
}

/**
 * The position the Previous button goes to. On the first song it wraps to the last with repeat all, otherwise it stays
 * (the caller then restarts the song). The "restart if played for more than 3 seconds" rule lives in the player.
 */
export function previousPosition(position: number, length: number, repeat: RepeatMode): number {
  if (position > 0) return position - 1;
  return repeat === 'all' && length > 0 ? length - 1 : 0;
}

/** off → all → one → off */
export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}
