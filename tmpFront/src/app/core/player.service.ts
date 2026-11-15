import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Track, coverUrl, streamUrl } from './api';
import {
  RepeatMode,
  advance,
  identityOrder,
  nextRepeatMode,
  previousPosition,
  reshuffledOrder,
  shuffledOrder,
} from './queue';

/** Creates the audio element. Tests replace it with a fake so no real sound or network is needed. */
export const AUDIO_FACTORY = new InjectionToken<() => HTMLAudioElement>('AUDIO_FACTORY', {
  providedIn: 'root',
  factory: () => () => new Audio(),
});

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
    audio.addEventListener('timeupdate', () => this.position.set(audio.currentTime));
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration)) this.duration.set(audio.duration);
    });
    audio.addEventListener('ended', () => this.step(true));
    audio.addEventListener('error', () => this.error.set('This track could not be played.'));
    this.setupMediaSession();
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
  }

  /** off → all → one → off */
  cycleRepeat(): void {
    this.repeat.update(nextRepeatMode);
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

  /** Loads the song at `position` in the play order. `autoplay = false` leaves it loaded but paused. */
  private startAt(position: number, autoplay = true): void {
    const track = this.queue()[this.order()[position]];
    if (!track) return;
    this.queuePosition.set(position);
    this.error.set(null);
    this.position.set(0);
    this.duration.set(track.duration || 0);
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
      if ((e as DOMException)?.name !== 'AbortError') this.error.set('Playback was blocked.');
    });
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    // Explicit actions (not toggle): a "pause" request while already paused must not start the music.
    session.setActionHandler('play', () => {
      if (this.current() && this.audio.paused) this.toggle();
    });
    session.setActionHandler('pause', () => this.audio.pause());
    session.setActionHandler('previoustrack', () => this.previous());
    session.setActionHandler('nexttrack', () => this.next());
    session.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) this.seek(details.seekTime);
    });
  }

  private updateMediaSession(track: Track): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: [{ src: coverUrl(track) }],
    });
  }
}
