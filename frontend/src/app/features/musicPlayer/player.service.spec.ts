import { TestBed } from '@angular/core/testing';
import { Track } from '../../core/api';
import { AUDIO_FACTORY, PlayerService, type PlanItem, type NativeState } from './player.service';
import type { RepeatMode } from './queue';

/** Stands in for HTMLAudioElement: records what the player asks for and lets a test "finish" a song. */
class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  volume = 1;
  preload = '';
  duration = NaN;
  paused = true;
  playCalls = 0;
  /** Set to make the next play() fail like the browser does: the load fails ('error' event) or it is not allowed. */
  failNextPlay: 'load' | 'not-allowed' | null = null;

  play(): Promise<void> {
    this.playCalls++;
    const failure = this.failNextPlay;
    this.failNextPlay = null;
    if (failure === 'load') {
      this.dispatchEvent(new Event('error'));
      return Promise.reject(new DOMException('Failed to load because no supported source was found.', 'NotSupportedError'));
    }
    if (failure === 'not-allowed') return Promise.reject(new DOMException('play() needs a user gesture', 'NotAllowedError'));
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  /** The current song reaches its end. */
  finish(): void {
    this.dispatchEvent(new Event('ended'));
  }
}

/** The phone's audio: Android's own player gets the whole play order, so it plays on without the app's screen. */
class PlanAudio extends FakeAudio {
  plans: { items: PlanItem[]; index: number; repeat: RepeatMode; context: string }[] = [];
  saved: NativeState | null = null;
  setPlan(items: PlanItem[], index: number, repeat: RepeatMode, context: string): void {
    this.plans.push({ items, index, repeat, context });
  }
  restore(): Promise<NativeState | null> {
    return Promise.resolve(this.saved);
  }
  /** Android moved to another song by itself (Next on the notification or a headset). */
  moveTo(index: number): void {
    this.dispatchEvent(new CustomEvent('itemchange', { detail: { index } }));
  }
}

const songs: Track[] = [1, 2, 3, 4, 5, 6].map((id) => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 200,
}));

describe('PlayerService', () => {
  let audio: FakeAudio;
  let player: PlayerService;

  beforeEach(() => {
    audio = new FakeAudio();
    TestBed.configureTestingModule({
      providers: [{ provide: AUDIO_FACTORY, useValue: () => audio as unknown as HTMLAudioElement }],
    });
    player = TestBed.inject(PlayerService);
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const title = () => player.current()?.title;

  describe('when a song cannot play', () => {
    it('a cloud song that cannot be loaded says so, not "blocked"', async () => {
      const cloudSong = { ...songs[0], id: -1, stream: 'https://cloud.example/songs/1/file' };
      audio.failNextPlay = 'load';
      player.play(cloudSong, [cloudSong]);
      await settle();
      expect(player.error()).toBe('This song could not be loaded from the cloud. Check the internet connection.');
    });

    it('a library song that cannot be loaded says it could not be played', async () => {
      audio.failNextPlay = 'load';
      player.play(songs[0], songs);
      await settle();
      expect(player.error()).toBe('This track could not be played.');
    });

    it('only a real refusal by the device says "blocked"', async () => {
      audio.failNextPlay = 'not-allowed';
      player.play(songs[0], songs);
      await settle();
      expect(player.error()).toBe('Playback was blocked. Press play to start it.');
    });
  });

  describe('on the phone (Android plays the songs, the app follows)', () => {
    let native: PlanAudio;
    const startWith = (saved: NativeState | null = null) => {
      native = new PlanAudio();
      native.saved = saved;
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: AUDIO_FACTORY, useValue: () => native as unknown as HTMLAudioElement }],
      });
      player = TestBed.inject(PlayerService);
    };
    const urls = (items: PlanItem[]) => items.map((i) => i.url);
    const withStreams = songs.map((s) => ({ ...s, stream: `https://cloud.example/songs/${s.id}/file` }));

    it('hands Android the whole play order, where to start and the repeat mode', () => {
      startWith();
      player.play(withStreams[2], withStreams);
      const plan = native.plans.at(-1)!;
      expect(urls(plan.items)).toEqual(withStreams.map((s) => s.stream));
      expect(plan.items[0]).toEqual({ url: withStreams[0].stream, title: 'Song 1', artist: 'Artist', album: 'Album', duration: 200 });
      expect(plan.index).toBe(2);
      expect(plan.repeat).toBe('off');
      expect(native.src).toBe(withStreams[2].stream);
    });

    it('the shuffled order and a new repeat mode are handed over at once', () => {
      startWith();
      player.play(withStreams[0], withStreams);
      player.toggleShuffle();
      let plan = native.plans.at(-1)!;
      expect(plan.index).toBe(0);
      expect(plan.items[0].url).toBe(withStreams[0].stream); // the song playing stays first
      expect(new Set(urls(plan.items))).toEqual(new Set(withStreams.map((s) => s.stream)));
      player.cycleRepeat();
      plan = native.plans.at(-1)!;
      expect(plan.repeat).toBe('all');
    });

    it('follows when Android moves to another song by itself', () => {
      startWith();
      player.play(withStreams[0], withStreams);
      const srcBefore = native.src;
      native.moveTo(3);
      expect(player.current()?.title).toBe('Song 4');
      expect(player.position()).toBe(0);
      expect(native.src).toBe(srcBefore); // nothing is loaded again: Android already plays it
    });

    it('reopened while Android still plays: takes over its queue, song, position and settings', async () => {
      startWith();
      player.play(withStreams[1], withStreams);
      player.toggleShuffle();
      player.cycleRepeat();
      const context = native.plans.at(-1)!.context;
      startWith({ context, index: 2, playing: true, position: 61, duration: 200 });
      await new Promise((r) => setTimeout(r, 0));
      const order = JSON.parse(context).order as number[];
      expect(player.queue().map((t) => t.title)).toEqual(withStreams.map((t) => t.title));
      expect(player.current()?.title).toBe(withStreams[order[2]].title);
      expect(player.playing()).toBe(true);
      expect(player.position()).toBe(61);
      expect(player.shuffle()).toBe(true);
      expect(player.repeat()).toBe('all');
      player.next(); // and carries on from there
      expect(player.current()?.title).toBe(withStreams[order[3]].title);
    });

    it('nothing playing on Android when the app opens: starts empty', async () => {
      startWith(null);
      await new Promise((r) => setTimeout(r, 0));
      expect(player.current()).toBeNull();
    });
  });

  describe('playing and auto-advance', () => {
    it('plays the clicked song from the queue', () => {
      player.play(songs[2], songs);
      expect(title()).toBe('Song 3');
      expect(audio.src).toContain('/library/3/stream');
      expect(player.playing()).toBe(true);
    });

    it('plays the next song by itself when one ends', () => {
      player.play(songs[0], songs);
      audio.finish();
      expect(title()).toBe('Song 2');
      expect(player.playing()).toBe(true);
      audio.finish();
      expect(title()).toBe('Song 3');
    });

    it('repeat off: after the last song it stops and returns to the first, paused', () => {
      player.play(songs[5], songs);
      audio.finish();
      expect(title()).toBe('Song 1');
      expect(player.playing()).toBe(false);
      expect(audio.paused).toBe(true);
    });

    it('does nothing when nothing is loaded', () => {
      player.next();
      player.previous();
      player.toggle();
      audio.finish();
      expect(player.current()).toBeNull();
    });
  });

  describe('repeat', () => {
    it('cycles off → all → one → off', () => {
      expect(player.repeat()).toBe('off');
      player.cycleRepeat();
      expect(player.repeat()).toBe('all');
      player.cycleRepeat();
      expect(player.repeat()).toBe('one');
      player.cycleRepeat();
      expect(player.repeat()).toBe('off');
    });

    it('repeat all: after the last song the first one plays again', () => {
      player.cycleRepeat();
      player.play(songs[5], songs);
      audio.finish();
      expect(title()).toBe('Song 1');
      expect(player.playing()).toBe(true);
    });

    it('repeat one: a song that ends restarts', () => {
      player.play(songs[1], songs);
      player.cycleRepeat();
      player.cycleRepeat();
      audio.currentTime = 150;
      const before = audio.playCalls;
      audio.finish();
      expect(title()).toBe('Song 2');
      expect(audio.currentTime).toBe(0);
      expect(audio.playCalls).toBe(before + 1);
    });

    it('repeat one: the Next button still moves on', () => {
      player.play(songs[1], songs);
      player.cycleRepeat();
      player.cycleRepeat();
      player.next();
      expect(title()).toBe('Song 3');
    });

    it('repeat all: Previous on the first song goes to the last', () => {
      player.cycleRepeat();
      player.play(songs[0], songs);
      player.previous();
      expect(title()).toBe('Song 6');
    });
  });

  describe('previous', () => {
    it('restarts the song when it has played for more than 3 seconds', () => {
      player.play(songs[2], songs);
      audio.currentTime = 10;
      player.previous();
      expect(title()).toBe('Song 3');
      expect(audio.currentTime).toBe(0);
    });

    it('goes to the previous song near the start', () => {
      player.play(songs[2], songs);
      audio.currentTime = 1;
      player.previous();
      expect(title()).toBe('Song 2');
    });

    it('repeat off: on the first song it just restarts', () => {
      player.play(songs[0], songs);
      audio.currentTime = 1;
      player.previous();
      expect(title()).toBe('Song 1');
      expect(audio.currentTime).toBe(0);
    });
  });

  describe('shuffle', () => {
    /** Plays through the whole queue with Next and returns the titles in the order they played. */
    function playthrough(): string[] {
      const seen = [title()!];
      for (let i = 1; i < songs.length; i++) {
        player.next();
        seen.push(title()!);
      }
      return seen;
    }

    it('turning it on keeps the current song playing', () => {
      player.play(songs[2], songs);
      player.toggleShuffle();
      expect(player.shuffle()).toBe(true);
      expect(title()).toBe('Song 3');
    });

    it('plays every song exactly once in a pass', () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        player.play(songs[3], songs);
        if (!player.shuffle()) player.toggleShuffle();
        const seen = playthrough();
        expect(new Set(seen).size).toBe(songs.length);
        expect(seen[0]).toBe('Song 4');
      }
    });

    it('does not simply play in list order', () => {
      let different = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        player.play(songs[0], songs);
        if (!player.shuffle()) player.toggleShuffle();
        const listOrder = songs.map((s) => s.title);
        if (playthrough().join() !== listOrder.join()) different++;
      }
      expect(different).toBeGreaterThan(15);
    });

    it('turning it off returns to list order from the current song', () => {
      player.play(songs[1], songs);
      player.toggleShuffle();
      player.next();
      const here = Number(title()!.split(' ')[1]);
      player.toggleShuffle();
      expect(title()).toBe(`Song ${here}`);
      player.next();
      expect(title()).toBe(`Song ${here + 1 > songs.length ? 1 : here + 1}`);
    });

    it('picking a song from the list while shuffling starts the new order with that song', () => {
      player.toggleShuffle();
      player.play(songs[4], songs);
      expect(title()).toBe('Song 5');
      const seen = [title()!];
      for (let i = 1; i < songs.length; i++) {
        player.next();
        seen.push(title()!);
      }
      expect(new Set(seen).size).toBe(songs.length);
    });

    it('repeat all + shuffle keeps going after a full pass, with a new pass that starts with a different song', () => {
      player.cycleRepeat(); // all
      player.play(songs[0], songs);
      player.toggleShuffle();
      const first = playthrough();
      const lastOfPass = first.at(-1);
      audio.finish(); // last song ends: a new shuffled pass begins
      expect(player.playing()).toBe(true);
      expect(title()).not.toBe(lastOfPass);
    });

    it('Previous goes back to the song that played before', () => {
      player.play(songs[0], songs);
      player.toggleShuffle();
      player.next();
      const second = title();
      player.next();
      audio.currentTime = 0;
      player.previous();
      expect(title()).toBe(second);
    });

    it('the list order of the queue is never changed', () => {
      player.play(songs[0], songs);
      player.toggleShuffle();
      expect(player.queue().map((s) => s.id)).toEqual(songs.map((s) => s.id));
    });
  });

  describe('volume and seeking', () => {
    it('clamps volume between 0 and 1', () => {
      player.setVolume(5);
      expect(audio.volume).toBe(1);
      player.setVolume(-1);
      expect(audio.volume).toBe(0);
    });

    it('seeks inside the current song', () => {
      player.play(songs[0], songs);
      player.seek(90);
      expect(audio.currentTime).toBe(90);
      expect(player.position()).toBe(90);
    });
  });

  describe('cloud songs', () => {
    const cloudSongs: Track[] = songs.slice(0, 3).map((s) => ({
      ...s,
      id: -s.id,
      stream: `/cloud/${s.id}/stream`,
      cover: `/cloud/${s.id}/cover`,
      prefetch: `/cloud/${s.id}/prefetch`,
    }));
    const reach = (seconds: number) => {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event('timeupdate'));
    };

    it('plays from the song’s own stream address', () => {
      player.play(cloudSongs[0], cloudSongs);
      expect(audio.src).toBe('/cloud/1/stream');
    });

    it('prefetches the next song once, at half time', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
      try {
        player.play(cloudSongs[0], cloudSongs);
        reach(90);
        expect(fetchSpy).not.toHaveBeenCalled();
        reach(101);
        reach(150);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith('/cloud/2/prefetch', { method: 'POST' });
        audio.finish(); // song 2 starts: at its half, song 3 is fetched
        reach(120);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenLastCalledWith('/cloud/3/prefetch', { method: 'POST' });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('does not prefetch library songs', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
      try {
        player.play(songs[0], songs);
        reach(150);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
