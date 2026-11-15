import {
  advance,
  identityOrder,
  nextRepeatMode,
  previousPosition,
  reshuffledOrder,
  shuffledOrder,
} from './queue';

/** A deterministic "random" source so shuffle tests are repeatable. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('shuffledOrder', () => {
  it('keeps the current song first and plays every other song exactly once', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const order = shuffledOrder(10, 4, seeded(seed));
      expect(order[0]).toBe(4);
      expect([...order].sort((a, b) => a - b)).toEqual(identityOrder(10));
    }
  });

  it('shuffles everything when there is no current song', () => {
    const order = shuffledOrder(8, -1, seeded(7));
    expect([...order].sort((a, b) => a - b)).toEqual(identityOrder(8));
  });

  it('really changes the order (not the identity) for a normal list', () => {
    const order = shuffledOrder(20, 0, seeded(3));
    expect(order).not.toEqual(identityOrder(20));
  });

  it('handles empty and single-song queues', () => {
    expect(shuffledOrder(0)).toEqual([]);
    expect(shuffledOrder(1, 0)).toEqual([0]);
  });
});

describe('reshuffledOrder', () => {
  it('starts a new pass that does not begin with the song that just finished', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const order = reshuffledOrder(5, 2, seeded(seed));
      expect(order[0]).not.toBe(2);
      expect([...order].sort((a, b) => a - b)).toEqual(identityOrder(5));
    }
  });

  it('copes with a single song', () => {
    expect(reshuffledOrder(1, 0)).toEqual([0]);
  });
});

describe('advance', () => {
  it('moves to the next song', () => {
    expect(advance(0, 3, 'off', true)).toEqual({ position: 1, stop: false, wrapped: false });
    expect(advance(1, 3, 'all', false)).toEqual({ position: 2, stop: false, wrapped: false });
  });

  it('repeat off: after the last song it stops and returns to the first', () => {
    expect(advance(2, 3, 'off', true)).toEqual({ position: 0, stop: true, wrapped: true });
  });

  it('repeat all: after the last song it carries on from the first', () => {
    expect(advance(2, 3, 'all', true)).toEqual({ position: 0, stop: false, wrapped: true });
  });

  it('repeat one: a song that ends plays again', () => {
    expect(advance(1, 3, 'one', true)).toEqual({ position: 1, stop: false, wrapped: false });
  });

  it('repeat one: the Next button still moves to another song', () => {
    expect(advance(1, 3, 'one', false)).toEqual({ position: 2, stop: false, wrapped: false });
  });

  it('an empty queue just stops', () => {
    expect(advance(0, 0, 'all', true).stop).toBe(true);
  });
});

describe('previousPosition', () => {
  it('goes back one song', () => {
    expect(previousPosition(2, 5, 'off')).toBe(1);
  });

  it('on the first song: repeat off stays (the player restarts it)', () => {
    expect(previousPosition(0, 5, 'off')).toBe(0);
    expect(previousPosition(0, 5, 'one')).toBe(0);
  });

  it('on the first song: repeat all wraps to the last', () => {
    expect(previousPosition(0, 5, 'all')).toBe(4);
  });
});

describe('nextRepeatMode', () => {
  it('cycles off → all → one → off', () => {
    expect(nextRepeatMode('off')).toBe('all');
    expect(nextRepeatMode('all')).toBe('one');
    expect(nextRepeatMode('one')).toBe('off');
  });
});
