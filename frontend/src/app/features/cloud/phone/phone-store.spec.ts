import type { ApiSong } from '../music-api';
import { PhoneStore } from './phone-store';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const song = (id: number, title = `Song ${id}`): ApiSong => ({
  id, file: `Band - ${title}.mp3`, title, artist: 'Band', album: '', duration: 100, isrc: null, key: '', size: 1000,
  addedBy: 'laptop', addedAt: '2026-01-01T00:00:00.000Z',
});

describe('PhoneStore', () => {
  it('settings: defaults, cleaned address, kept key unless a new one is typed, saved across restarts', () => {
    const storage = new MemoryStorage();
    const store = new PhoneStore(storage);
    expect(store.settings()).toEqual({ url: '', key: '', name: '', online: true });
    store.saveSettings({ url: 'www.example.com/music-api/', key: 'secret-key', name: ' Tyler ' });
    store.saveSettings({ key: '' });
    expect(new PhoneStore(storage).settings()).toEqual({ url: 'https://www.example.com/music-api', key: 'secret-key', name: 'Tyler', online: true });
    expect(() => store.saveSettings({ url: 'not an address' })).toThrow(/must look like/);
  });

  it('a broken or missing storage never breaks the app', () => {
    const broken = { getItem: () => '{oops', setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    const store = new PhoneStore(broken);
    expect(store.settings().online).toBe(true);
    expect(store.saved()).toEqual([]);
    expect(() => store.saveLastSongs([song(1)])).not.toThrow();
  });

  it('saved songs: add, rename, remove, kept across restarts', () => {
    const storage = new MemoryStorage();
    const store = new PhoneStore(storage);
    store.addSaved({ ...song(1), local: '1.mp3', uri: 'file:///data/songs/1.mp3' });
    store.addSaved({ ...song(2), local: '2.mp3', uri: 'file:///data/songs/2.mp3' });
    store.addSaved({ ...song(1, 'Again'), local: '1.mp3', uri: 'file:///data/songs/1.mp3' });
    expect(store.saved().map((s) => s.title)).toEqual(['Again', 'Song 2']);
    expect(store.isSaved(2)).toBe(true);
    store.updateSaved(2, { title: 'Two', artist: 'Other', genre: 'Rap' });
    expect(new PhoneStore(storage).findSaved(2)).toMatchObject({ title: 'Two', artist: 'Other', genre: 'Rap', local: '2.mp3' });
    expect(store.removeSaved(1)?.local).toBe('1.mp3');
    expect(store.removeSaved(1)).toBeNull();
    expect(store.saved().map((s) => s.id)).toEqual([2]);
  });

  it('the last cloud list is kept for when the cloud cannot be reached', () => {
    const storage = new MemoryStorage();
    new PhoneStore(storage).saveLastSongs([song(1), song(2)]);
    expect(new PhoneStore(storage).lastSongs().map((s) => s.id)).toEqual([1, 2]);
  });
});
