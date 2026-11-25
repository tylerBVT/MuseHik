import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Track, coverUrl, streamUrl } from '../../core/api';
import { createNativeAudio } from '../../core/native-audio';
import {
  RepeatMode,
  advance,
  identityOrder,
  nextRepeatMode,
  previousPosition,
  reshuffledOrder,
  shuffledOrder,
} from './queue';

/**
 * Creates the audio element. In the Android app it is Android's own player (core/native-audio.ts), so the music goes
 * on with the screen off and after the app is swiped away. Tests replace it with a fake (no real sound or network).
 */
export const AUDIO_FACTORY = new InjectionToken<() => HTMLAudioElement>('AUDIO_FACTORY', {
  providedIn: 'root',
  factory: () => () => (Capacitor.isNativePlatform() ? (createNativeAudio() as unknown as HTMLAudioElement) : new Audio()),
});

/** One song of the play order, as Android's player needs it. */
export type PlanItem = { url: string; title: string; artist: string; album: string; duration: number };
/** What Android still plays when the app opens again; `context` is the player's own state (queue, order, modes). */
export type NativeState = { context: string; index: number; playing: boolean; position: number; duration: number };
/**
 * Audio that plays a whole play order by itself (the phone): it moves to the next song alone when the app's screen is
 * gone, says 'itemchange' when it moved for another reason (the notification's Next), and can tell what it plays.
 */
type PlanAudio = {
  setPlan(items: PlanItem[], index: number, repeat: RepeatMode, context: string): void;
  restore(): Promise<NativeState | null>;
};
/** A press on media keys or the browser's media controls. */
type DeviceAction = { action: 'play' | 'pause' | 'next' | 'previous' } | { action: 'seek'; seconds: number };
const playsPlans = (audio: object): audio is PlanAudio => 'setPlan' in audio && 'restore' in audio;

/** A second press of Previous within this many seconds goes to the previous song; later it restarts the song. */
const RESTART_AFTER_SECONDS = 3;

/**
 * The audio player. Wraps one HTMLAudioElement and exposes its state as signals. The queue is whatever list the user
 * started playing from (the visible library). What plays next is decided by the pure rules in `queue.ts`.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly audio = inject(AUDIO_FACTORY)();

  /** The songs in list order. Never reordered; shuffle only changes `order`. */
  readonly queue = signal<Track[]>([]);
  /** Indexes into `queue` in play order (identity normally, a random permutation while shuffling). */
  private readonly order = signal<number[]>([]);
  /** Where we are inside `order`. */
  private readonly queuePosition = signal(-1);

  readonly current = computed<Track | null>(() => {
    const index = this.order()[this.queuePosition()];
    return index === undefined ? null : (this.queue()[index] ?? null);
  });
  readonly playing = signal(false);
  /** Seconds played of the current song. */
  readonly position = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(0.8);
  readonly error = signal<string | null>(null);
  readonly shuffle = signal(false);
  readonly repeat = signal<RepeatMode>('off');
  /** Whether the next song was already fetched in advance during the current one. */
  private prefetched = false;

  readonly hasNext = computed(
    () => this.queue().length > 1 && (this.repeat() === 'all' || this.queuePosition() < this.queue().length - 1),
  );
  readonly hasPrevious = computed(() => this.queuePosition() > 0 || (this.repeat() === 'all' && this.queue().length > 1));

  constructor() {
    const audio = this.audio;
    audio.preload = 'metadata';
    audio.volume = this.volume();
    audio.addEventListener('play', () => this.playing.set(true));
    audio.addEventListener('pause', () => this.playing.set(false));
    audio.addEventListener('timeupdate', () => {
      this.position.set(audio.currentTime);
      this.prefetchNext();
    });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration)) this.duration.set(audio.duration);
    });
    audio.addEventListener('ended', () => this.step(true));
    audio.addEventListener('error', () => this.error.set(this.cannotPlayMessage()));
    this.setupMediaSession();
    const planAudio = audio as unknown as object;
    if (playsPlans(planAudio)) {
      audio.addEventListener('itemchange', (e) => this.followTo((e as CustomEvent<{ index: number }>).detail.index));
      void planAudio.restore().then((state) => state && this.adopt(state));
    }
  }

  /** Starts a track and uses `queue` (usually the list on screen) for next/previous. */
  play(track: Track, queue: Track[] = this.queue()): void {
    const found = queue.findIndex((t) => t.id === track.id);
    const songs = found === -1 ? [track] : queue;
    const index = found === -1 ? 0 : found;
    this.queue.set(songs);
    if (this.shuffle()) {
      this.order.set(shuffledOrder(songs.length, index));
      this.startAt(0);
    } else {
      this.order.set(identityOrder(songs.length));
      this.startAt(index);
    }
  }

  toggle(): void {
    if (!this.current()) return;
    if (this.audio.paused) this.tryPlay();
    else this.audio.pause();
  }

  next(): void {
    if (this.current()) this.step(false);
  }

  /** Like most players: after a few seconds in, Previous restarts the song; otherwise it goes back. */
  previous(): void {
    if (!this.current()) return;
    if (this.audio.currentTime > RESTART_AFTER_SECONDS) return this.seek(0);
    const here = this.queuePosition();
    const target = previousPosition(here, this.queue().length, this.repeat());
    if (target === here) this.seek(0);
    else this.startAt(target);
  }

  seek(seconds: number): void {
    if (!this.current()) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.duration() || seconds));
    this.position.set(this.audio.currentTime);
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.audio.volume = clamped;
    this.volume.set(clamped);
  }

  /**
   * Turning shuffle on keeps the song that is playing and shuffles the rest after it (nothing jumps).
   * Turning it off goes back to list order and carries on from the song that is playing.
   */
  toggleShuffle(): void {
    const songs = this.queue().length;
    const index = this.order()[this.queuePosition()];
    const turningOn = !this.shuffle();
    this.shuffle.set(turningOn);
    if (index === undefined) return; // nothing playing yet: the next play() uses the new setting
    if (turningOn) {
      this.order.set(shuffledOrder(songs, index));
      this.queuePosition.set(0);
    } else {
      this.order.set(identityOrder(songs));
      this.queuePosition.set(index);
    }
    this.syncPlan();
  }

  /** off → all → one → off */
  cycleRepeat(): void {
    this.repeat.update(nextRepeatMode);
    this.syncPlan();
  }

  /** Moves on, either because the song ended by itself or because Next was pressed. */
  private step(ended: boolean): void {
    const length = this.queue().length;
    if (!length || !this.current()) return;

    if (ended && this.repeat() === 'one') {
      this.audio.currentTime = 0;
      this.tryPlay();
      return;
    }

    const here = this.queuePosition();
    const step = advance(here, length, this.repeat(), ended);
    if (step.wrapped && this.shuffle()) {
      // A new shuffled pass (the song that just played does not open it).
      this.order.set(reshuffledOrder(length, this.order()[here]));
    }
    this.startAt(step.position, !step.stop);
  }

  /**
   * Halfway through a song, asks the server to fetch the next one if it is a cloud song, so it starts without a
   * wait. Once per song; only when the next song is known (not at the end of a shuffled pass).
   */
  private prefetchNext(): void {
    if (this.prefetched || !(this.duration() > 0) || this.audio.currentTime < this.duration() / 2) return;
    this.prefetched = true;
    if (this.repeat() === 'one') return;
    const step = advance(this.queuePosition(), this.queue().length, this.repeat(), true);
    if (step.stop || (step.wrapped && this.shuffle())) return;
    const next = this.queue()[this.order()[step.position]];
    if (next?.prefetch && next !== this.current()) {
      fetch(next.prefetch, { method: 'POST' }).catch(() => {
        /* only a head start: playing it later fetches it anyway */
      });
    }
  }

  /** Loads the song at `position` in the play order. `autoplay = false` leaves it loaded but paused. */
  private startAt(position: number, autoplay = true): void {
    const track = this.queue()[this.order()[position]];
    if (!track) return;
    this.prefetched = false;
    this.queuePosition.set(position);
    this.error.set(null);
    this.position.set(0);
    this.duration.set(track.duration || 0);
    this.syncPlan();
    this.audio.src = streamUrl(track);
    if (autoplay) {
      this.tryPlay();
    } else {
      this.audio.pause();
      this.playing.set(false);
    }
    this.updateMediaSession(track);
  }

  /** Lock-screen / media-key controls and "now playing" info (useful later on Android too). */
  /** Starts playback. A play() cut short by a newer track or a pause (AbortError) is normal, not an error. */
  private tryPlay(): void {
    this.audio.play().catch((e: unknown) => {
      const name = (e as DOMException)?.name;
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') this.error.set('Playback was blocked. Press play to start it.');
      // A song that failed to load already said so through the 'error' event.
      else if (!this.error()) this.error.set(this.cannotPlayMessage());
    });
  }

  /** Cloud songs mostly fail because the connection is gone (no signal, or the phone cut it). */
  private cannotPlayMessage(): string {
    return this.current()?.stream?.startsWith('http')
      ? 'This song could not be loaded from the cloud. Check the internet connection.'
      : 'This track could not be played.';
  }

  /** The phone: hands Android the whole play order, so it can move on alone (screen off, app swiped away). */
  private syncPlan(): void {
    const audio = this.audio as unknown as object;
    if (!playsPlans(audio) || this.queuePosition() < 0) return;
    const queue = this.queue();
    const items = this.order().map((i) => {
      const t = queue[i];
      return { url: streamUrl(t), title: t.title, artist: t.artist, album: t.album, duration: t.duration };
    });
    const context = JSON.stringify({ queue, order: this.order(), shuffle: this.shuffle(), repeat: this.repeat() });
    audio.setPlan(items, this.queuePosition(), this.repeat(), context);
  }

  /** Android moved to another song of the plan by itself (Next on the notification): show it, load nothing. */
  private followTo(position: number): void {
    if (position === this.queuePosition() || !this.order().length) return;
    this.queuePosition.set(position);
    this.position.set(0);
    this.duration.set(this.current()?.duration || 0);
    this.error.set(null);
    this.prefetched = false;
    const track = this.current();
    if (track) this.updateMediaSession(track);
  }

  /** The app opened while Android still plays (it was swiped away, or Android closed its screen): carry on from there. */
  private adopt(state: NativeState): void {
    if (this.current()) return; // the user already started something
    let saved: { queue: Track[]; order: number[]; shuffle: boolean; repeat: RepeatMode };
    try {
      saved = JSON.parse(state.context);
    } catch {
      return;
    }
    if (!saved?.queue?.length || saved.order?.[state.index] === undefined) return;
    this.queue.set(saved.queue);
    this.order.set(saved.order);
    this.shuffle.set(saved.shuffle);
    this.repeat.set(saved.repeat);
    this.queuePosition.set(state.index);
    this.playing.set(state.playing);
    this.position.set(state.position);
    this.duration.set(state.duration || this.current()?.duration || 0);
    this.syncPlan(); // the audio learns the plan again (Android keeps playing the same song)
  }

  /** Explicit play / pause (not toggle): a "pause" from a call while already paused must not start the music. */
  private onDeviceAction(a: DeviceAction): void {
    if (!this.current()) return;
    switch (a.action) {
      case 'play':
        if (this.audio.paused) this.tryPlay();
        break;
      case 'pause':
        this.audio.pause();
        break;
      case 'next':
        this.next();
        break;
      case 'previous':
        this.previous();
        break;
      case 'seek':
        this.seek(a.seconds);
        break;
    }
  }



  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', () => this.onDeviceAction({ action: 'play' }));
    session.setActionHandler('pause', () => this.onDeviceAction({ action: 'pause' }));
    session.setActionHandler('previoustrack', () => this.onDeviceAction({ action: 'previous' }));
    session.setActionHandler('nexttrack', () => this.onDeviceAction({ action: 'next' }));
    session.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) this.onDeviceAction({ action: 'seek', seconds: details.seekTime });
    });
  }

  private updateMediaSession(track: Track): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: coverUrl(track) ? [{ src: coverUrl(track) }] : [],
    });
  }
}
