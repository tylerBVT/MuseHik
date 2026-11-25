import type { ApiSong, MusicApi } from '../music-api';
import { MusicApiError } from '../music-api';
import { PhoneCloud, type MusicFile, type PhoneDevice } from './phone-cloud';
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

/** A song in the phone's Music folder (what Android's media index says about it). */
const music = (id: number, title: string, mine = false): MusicFile => ({
  id, uri: `content://media/external/audio/media/${id}`, title, artist: 'Cable', album: 'Al', duration: 200,
  addedAt: '2026-11-24T10:00:00.000Z', size: 5000, mine,
});

function setup({ songs = [song(1), song(2)], reachable = true, musicFolder = [] as MusicFile[] } = {}) {
  /** The app's private storage: file name -> where it was downloaded from. */
  const files = new Map<string, string>();
  /** The phone's Music folder (Android's media index): id -> song, plus the name each was saved under. */
  const folder = new Map<number, MusicFile & { name?: string; from?: string }>(musicFolder.map((m) => [m.id, m]));
  let nextId = 100;
  const device: PhoneDevice = {
    downloadSong: async (url, local) => {
      files.set(local, url);
      return `file:///data/songs/${local}`;
    },
    deleteSongFile: async (local) => {
      files.delete(local);
    },
    playable: (uri) => (uri.startsWith('content://') ? uri : `https://localhost/_capacitor_file_${uri.slice(7)}`),
    readTags: async () => ({ title: 't', artist: 'a', album: '', duration: 1, isrc: null }),
    listMusic: async () => [...folder.values()],
    saveToMusic: async (from, name) => {
      const id = nextId++;
      folder.set(id, { ...music(id, name), mine: true, name, from });
      return { id, uri: `content://media/external/audio/media/${id}` };
    },
    deleteMusic: async (id) => {
      if (!folder.get(id)?.mine) throw new Error('RecoverableSecurityException');
      folder.delete(id);
    },
  };
  const fail = () => Promise.reject(new MusicApiError('Cannot reach the host.'));
  const api = {
    status: () => (reachable ? Promise.resolve({ storedBytes: 25e9, storageLimitBytes: 30e9, songs: 2 }) : fail()),
    songs: () => (reachable ? Promise.resolve({ songs, synced: { added: 0, removed: 0 } }) : fail()),
    editSong: async (id: number, changes: object) => ({ ...song(id), ...changes }),
    deleteSong: async (id: number) => songs.some((s) => s.id === id),
    fileUrl: (id: number) => `https://cloud/songs/${id}/file?key=k`,
  } as unknown as MusicApi;
  const store = new PhoneStore(new MemoryStorage());
  const cloud = new PhoneCloud(store, device, () => api);
  return { cloud, store, files, folder };
}

describe('PhoneCloud', () => {
  it('nothing reaches the network before the cloud is set up', async () => {
    const { cloud } = setup();
    expect(await cloud.status()).toEqual({ configured: false });
    expect((await cloud.testConnection()).ok).toBe(false);
    expect(() => cloud.startUpload([])).toThrow(/Set up the cloud/);
  });

  it('status gives the storage bar, with a warning past 80 %', async () => {
    const { cloud } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    expect(await cloud.status()).toMatchObject({ configured: true, online: true, percent: 83.3, warning: true });
    expect(await cloud.testConnection()).toEqual({ ok: true, secure: true });
  });

  it('songs are streamed with the key, or saved into Music/MuseHik under their name and played from there', async () => {
    const { cloud, files, folder } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    expect(cloud.toTrack(song(1)).stream).toBe('https://cloud/songs/1/file?key=k');
    expect(cloud.toTrack(song(1)).id).toBe(-1);

    const { jobId } = await cloud.startSave([1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(cloud.getSave(jobId)?.saved.map((s) => s.id)).toEqual([1]);
    const saved = folder.get(100)!;
    expect(saved).toMatchObject({ name: 'Band - Song 1.mp3', from: 'file:///data/songs/1.mp3' });
    expect(files.size).toBe(0); // the download went to the Music folder; nothing left in the app's storage
    expect(cloud.toTrack(song(1)).stream).toBe('content://media/external/audio/media/100');
    expect((await cloud.phoneTracks()).map((t) => t.id)).toEqual([-1]);
    expect((await cloud.songs()).songs.map((s) => s.onLaptop)).toEqual([true, false]);
  });

  it('All tracks: every song in the Music folder (copied by cable too); saved cloud songs keep their cloud identity', async () => {
    const { cloud } = setup({ musicFolder: [music(7, 'From cable')] });
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([2]);
    await new Promise((r) => setTimeout(r, 10));
    const tracks = await cloud.phoneTracks();
    expect(tracks.map((t) => [t.id, t.title])).toEqual([[7, 'From cable'], [-2, 'Song 2']]);
    expect(tracks[0]).toMatchObject({ artist: 'Cable', album: 'Al', duration: 200, addedAt: '2026-11-24T10:00:00.000Z', stream: 'content://media/external/audio/media/7', cover: '' });
  });

  it('a saved song deleted from the phone by cable is no longer "on this phone"', async () => {
    const { cloud, store, folder } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([1]);
    await new Promise((r) => setTimeout(r, 10));
    folder.clear(); // deleted from the computer
    expect(await cloud.phoneTracks()).toEqual([]);
    expect(store.isSaved(1)).toBe(false);
  });

  it('songs saved by an older version (in the app storage) move to the Music folder', async () => {
    const { cloud, store, files, folder } = setup();
    files.set('1.mp3', 'old');
    store.addSaved({ ...song(1), local: '1.mp3', uri: 'file:///data/songs/1.mp3' });
    const tracks = await cloud.phoneTracks();
    expect(folder.get(100)).toMatchObject({ name: 'Band - Song 1.mp3', from: 'file:///data/songs/1.mp3' });
    expect(files.has('1.mp3')).toBe(false);
    expect(tracks.map((t) => [t.id, t.stream])).toEqual([[-1, 'content://media/external/audio/media/100']]);
  });

  it('remove from the phone: songs the app saved go; a song copied by cable says where to delete it', async () => {
    const { cloud, folder } = setup({ musicFolder: [music(7, 'From cable')] });
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([1]);
    await new Promise((r) => setTimeout(r, 10));
    await cloud.removeFromPhone(1);
    expect(folder.has(100)).toBe(false);
    await expect(cloud.deleteFromPhone(7)).rejects.toThrow('Delete songs copied by cable from your computer or the Files app.');
    expect(folder.has(7)).toBe(true);
  });

  it('a rename on the cloud also renames the copy on the phone', async () => {
    const { cloud, store } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([2]);
    await new Promise((r) => setTimeout(r, 0));
    let told = 0;
    cloud.onSavedChange = () => told++;
    await cloud.editSong(2, { title: 'Two' });
    expect(store.findSaved(2)?.title).toBe('Two');
    expect(told).toBe(1);
  });

  it('remove from the phone: when Android does not delete the file, it says so and the song stays saved', async () => {
    const { cloud, store, folder } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([1]);
    await new Promise((r) => setTimeout(r, 10));
    folder.get(100)!.mine = false; // Android refuses
    await expect(cloud.removeFromPhone(1)).rejects.toThrow('Could not delete it from this phone.');
    expect(store.isSaved(1)).toBe(true);
    expect(folder.has(100)).toBe(true);
  });

  it('remove from phone deletes the file only; delete from cloud keeps the copy on the phone', async () => {
    const { cloud, store, folder } = setup();
    cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await cloud.startSave([1, 2]);
    await new Promise((r) => setTimeout(r, 10));
    await cloud.removeFromPhone(1);
    expect(folder.has(100)).toBe(false);
    expect(store.isSaved(1)).toBe(false);
    await cloud.deleteSong(2);
    expect(store.isSaved(2)).toBe(true);
    await expect(cloud.deleteSong(99)).rejects.toThrow('This song is not on the cloud.');
  });

  it('unreachable or switched off: the last list seen, saved songs still play', async () => {
    const online = setup();
    online.cloud.saveSettings({ url: 'https://cloud', key: 'k' });
    await online.cloud.songs();
    const storage = online.store;
    const offline = new PhoneCloud(storage, {} as PhoneDevice, () => {
      throw new Error('no network');
    });
    const result = await offline.songs();
    expect(result.offline).toBe(true);
    expect(result.songs.map((s) => s.id)).toEqual([1, 2]);

    offline.saveSettings({ online: false });
    expect(await offline.songs()).toMatchObject({ offline: true, mode: 'offline' });
    expect(await offline.status()).toEqual({ configured: true, online: false });
  });
});
