// The phone's audio: Android's own player (Media3, in android/.../MusicService.java, reached through
// NativePlayerPlugin.java), dressed as the <audio> element the PlayerService already drives. It also receives the whole
// play order, so Android moves to the next song by itself: the music goes on with the screen off and after the app is
// swiped away from the recent apps, like other music apps. The notification, lock screen, headset buttons, calls and
// unplugged headphones are all handled by Android's player.
import { registerPlugin } from '@capacitor/core';
import type { NativeState, PlanItem } from '../features/musicPlayer/player.service';
import type { RepeatMode } from '../features/musicPlayer/queue';

/** What Android's player says. 'item': it is on another song of the plan (moved on alone, repeated, or was sent). */
export type NativeEvent = {
  type: 'play' | 'pause' | 'time' | 'duration' | 'ended' | 'error' | 'item';
  index: number;
  position: number;
  duration: number;
  reason?: 'auto' | 'repeat' | 'seek' | 'plan';
  message?: string;
};

export type NativePlayerPlugin = {
  setPlan(options: { items: PlanItem[]; index: number; repeat: RepeatMode; context: string }): Promise<void>;
  select(options: { index: number }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { seconds: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  getState(): Promise<Partial<NativeState>>;
  addListener(event: 'state', handler: (event: NativeEvent) => void): Promise<unknown>;
};

/** Songs saved on the phone are given to the WebView through this address; Android's player reads the file itself. */
const LOCAL_FILE = 'https://localhost/_capacitor_file_';
const nativeUrl = (url: string) => (url.startsWith(LOCAL_FILE) ? `file://${url.slice(LOCAL_FILE.length)}` : url);

const quietly = (p: Promise<unknown>) => void p.catch((e) => console.warn('[player]', e));

export class NativeAudio extends EventTarget {
  preload = '';
  paused = true;
  duration = NaN;
  error: { message: string } | null = null;
  private time = 0;
  private level = 1;
  private url = '';
  private planUrls: string[] = [];
  private planKey = '';
  /** The song the player said it is about to load (setPlan's index). */
  private wanted = -1;
  /** Android moved to this song by itself: the player's own request for it, right after, must not restart it. */
  private arrivedAlone = -1;
  private readonly native: NativePlayerPlugin;

  constructor(native: NativePlayerPlugin) {
    super();
    this.native = native;
    quietly(native.addListener('state', (e) => this.onNative(e)));
  }

  setPlan(items: PlanItem[], index: number, repeat: RepeatMode, context: string): void {
    this.wanted = index;
    const key = JSON.stringify([items.map((i) => i.url), repeat]);
    if (key === this.planKey) return;
    this.planKey = key;
    this.planUrls = items.map((i) => i.url);
    quietly(this.native.setPlan({ items: items.map((i) => ({ ...i, url: nativeUrl(i.url) })), index, repeat, context }));
  }

  /** What Android still plays (after the app was closed and opened again); null when nothing. */
  async restore(): Promise<NativeState | null> {
    const s = await this.native.getState();
    if (!s.context) return null;
    const state: NativeState = {
      context: s.context, index: s.index ?? 0, playing: Boolean(s.playing), position: s.position ?? 0, duration: s.duration ?? 0,
    };
    this.paused = !state.playing;
    this.time = state.position;
    this.duration = state.duration;
    return state;
  }

  get src(): string {
    return this.url;
  }

  set src(url: string) {
    this.url = url;
    this.time = 0;
    this.error = null;
    const index = this.planUrls[this.wanted] === url ? this.wanted : this.planUrls.indexOf(url);
    if (index < 0) {
      // Not part of a plan: played on its own.
      this.planUrls = [url];
      this.planKey = '';
      this.wanted = 0;
      this.arrivedAlone = -1;
      quietly(this.native.setPlan({ items: [{ url: nativeUrl(url), title: '', artist: '', album: '', duration: 0 }], index: 0, repeat: 'off', context: '' }));
      return;
    }
    const alone = this.arrivedAlone === index;
    this.arrivedAlone = -1;
    if (!alone) quietly(this.native.select({ index }));
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = seconds;
    quietly(this.native.seek({ seconds }));
  }

  get volume(): number {
    return this.level;
  }

  set volume(level: number) {
    this.level = level;
    quietly(this.native.setVolume({ volume: level }));
  }

  play(): Promise<void> {
    this.paused = false;
    return this.native.play();
  }

  pause(): void {
    this.paused = true;
    quietly(this.native.pause());
  }

  private onNative(e: NativeEvent): void {
    switch (e.type) {
      case 'play':
        this.paused = false;
        this.dispatchEvent(new Event('play'));
        break;
      case 'pause':
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
        break;
      case 'time':
        this.time = e.position;
        this.dispatchEvent(new Event('timeupdate'));
        break;
      case 'duration':
        this.duration = e.duration;
        this.dispatchEvent(new Event('durationchange'));
        break;
      case 'ended': // the end of the plan
        this.paused = true;
        this.dispatchEvent(new Event('ended'));
        break;
      case 'error':
        this.error = { message: e.message ?? '' };
        this.dispatchEvent(new Event('error'));
        break;
      case 'item':
        this.onItem(e);
        break;
    }
  }

  private onItem(e: NativeEvent): void {
    this.time = 0;
    if (e.reason === 'repeat') {
      this.dispatchEvent(new Event('timeupdate'));
    } else if (e.reason === 'auto') {
      // Moved on alone: to the player this is the song ending (it then asks for the song Android already plays).
      this.url = this.planUrls[e.index] ?? this.url;
      this.arrivedAlone = e.index;
      this.dispatchEvent(new Event('ended'));
    } else if (e.reason === 'seek' && this.planUrls[e.index] !== undefined && this.planUrls[e.index] !== this.url) {
      // Moved for another reason (Next / Previous on the notification or a headset).
      this.url = this.planUrls[e.index];
      this.arrivedAlone = -1;
      this.dispatchEvent(new CustomEvent('itemchange', { detail: { index: e.index } }));
    }
  }
}

export function createNativeAudio(): NativeAudio {
  return new NativeAudio(registerPlugin<NativePlayerPlugin>('NativePlayer'));
}
