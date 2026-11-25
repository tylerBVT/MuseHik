import { NativeAudio, type NativeEvent, type NativePlayerPlugin } from './native-audio';
import type { PlanItem } from '../features/musicPlayer/player.service';

/** Stands in for the Android plugin: records the calls, lets a test send its events. */
function fakePlugin() {
  const calls: [string, unknown][] = [];
  let listener: (e: NativeEvent) => void = () => {};
  let state: Record<string, unknown> = {};
  const record = (name: string) => (arg?: unknown) => {
    calls.push([name, arg]);
    return Promise.resolve();
  };
  const plugin: NativePlayerPlugin = {
    setPlan: record('setPlan'),
    select: record('select'),
    play: record('play'),
    pause: record('pause'),
    seek: record('seek'),
    setVolume: record('setVolume'),
    getState: () => Promise.resolve(state as never),
    addListener: (_e, h) => ((listener = h), Promise.resolve({})),
  };
  return {
    plugin,
    calls,
    names: () => calls.map(([n]) => n),
    send: (e: Partial<NativeEvent>) => listener({ index: 0, position: 0, duration: 0, ...e } as NativeEvent),
    setState: (s: Record<string, unknown>) => (state = s),
  };
}

const item = (id: number, url = `https://cloud.example/songs/${id}/file?key=k`): PlanItem => ({
  url, title: `Song ${id}`, artist: 'A', album: '', duration: 100,
});
const plan = [item(1), item(2), item(3)];

describe('NativeAudio (the phone plays through Android, like an <audio> element)', () => {
  let fake: ReturnType<typeof fakePlugin>;
  let audio: NativeAudio;
  const seen: string[] = [];

  beforeEach(() => {
    fake = fakePlugin();
    audio = new NativeAudio(fake.plugin);
    seen.length = 0;
    for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'ended', 'error', 'itemchange']) {
      audio.addEventListener(type, () => seen.push(type));
    }
  });

  it('sends the plan once, songs saved on the phone as their real file', () => {
    const saved = item(9, 'https://localhost/_capacitor_file_/data/user/0/com.musehik.app/files/songs/9.mp3');
    audio.setPlan([...plan, saved], 0, 'all', '{"c":1}');
    audio.setPlan([...plan, saved], 1, 'all', '{"c":1}'); // same songs, same repeat: nothing new for Android
    expect(fake.names()).toEqual(['setPlan']);
    const sent = fake.calls[0][1] as { items: PlanItem[]; index: number; repeat: string; context: string };
    expect(sent.items[3].url).toBe('file:///data/user/0/com.musehik.app/files/songs/9.mp3');
    expect(sent.items[0].url).toBe(plan[0].url);
    expect(sent).toMatchObject({ index: 0, repeat: 'all', context: '{"c":1}' });
  });

  it('setting src picks that song of the plan (from its start)', () => {
    audio.setPlan(plan, 2, 'off', '');
    audio.src = plan[2].url;
    expect(fake.calls.at(-1)).toEqual(['select', { index: 2 }]);
    expect(audio.src).toBe(plan[2].url);
  });

  it('a song outside the plan is played on its own', () => {
    audio.src = plan[1].url;
    expect(fake.calls.at(-1)?.[0]).toBe('setPlan');
    expect((fake.calls.at(-1)?.[1] as { items: PlanItem[] }).items.map((i) => i.url)).toEqual([plan[1].url]);
  });

  it('Android moving on by itself counts as the song ending; the player then asking for that song changes nothing', () => {
    audio.setPlan(plan, 0, 'off', '');
    audio.src = plan[0].url;
    fake.send({ type: 'item', reason: 'auto', index: 1 });
    expect(seen).toEqual(['ended']);
    const before = fake.calls.length;
    audio.src = plan[1].url; // the player's own step after 'ended'
    expect(fake.calls.length).toBe(before);
    audio.src = plan[1].url; // asked again later (the same song clicked): restarts it
    expect(fake.calls.at(-1)).toEqual(['select', { index: 1 }]);
  });

  it('a song repeating by itself is not an end; Next pressed on the notification is a song change', () => {
    audio.setPlan(plan, 0, 'one', '');
    audio.src = plan[0].url;
    fake.send({ type: 'item', reason: 'repeat', index: 0 });
    expect(seen).toEqual(['timeupdate']);
    expect(audio.currentTime).toBe(0);
    let moved = -1;
    audio.addEventListener('itemchange', (e) => (moved = (e as CustomEvent<{ index: number }>).detail.index));
    fake.send({ type: 'item', reason: 'seek', index: 2 });
    expect(moved).toBe(2);
    expect(audio.src).toBe(plan[2].url);
  });

  it('play, pause, time, length, end and errors come through as the usual events', () => {
    fake.send({ type: 'play' });
    expect(audio.paused).toBe(false);
    fake.send({ type: 'time', position: 12.5 });
    expect(audio.currentTime).toBe(12.5);
    fake.send({ type: 'duration', duration: 187 });
    expect(audio.duration).toBe(187);
    fake.send({ type: 'pause' });
    expect(audio.paused).toBe(true);
    fake.send({ type: 'ended' });
    fake.send({ type: 'error', message: 'Source error' });
    expect(seen).toEqual(['play', 'timeupdate', 'durationchange', 'pause', 'ended', 'error']);
  });

  it('controls go to Android: play, pause, seek, volume', async () => {
    await audio.play();
    expect(audio.paused).toBe(false);
    audio.pause();
    expect(audio.paused).toBe(true);
    audio.currentTime = 33;
    audio.volume = 0.5;
    expect(fake.calls.slice(-4)).toEqual([['play', undefined], ['pause', undefined], ['seek', { seconds: 33 }], ['setVolume', { volume: 0.5 }]]);
    expect(audio.currentTime).toBe(33);
    expect(audio.volume).toBe(0.5);
  });

  it('restore: what Android still plays after the app was closed and reopened', async () => {
    fake.setState({});
    expect(await audio.restore()).toBeNull();
    fake.setState({ context: '{"queue":[]}', index: 1, playing: true, position: 40, duration: 180 });
    expect(await audio.restore()).toEqual({ context: '{"queue":[]}', index: 1, playing: true, position: 40, duration: 180 });
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(40);
    expect(audio.duration).toBe(180);
  });
});
