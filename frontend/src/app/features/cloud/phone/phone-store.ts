// What the phone keeps between launches, in the app's local storage: the cloud settings, the songs saved on the phone
// (their files are in the Music/MuseHik folder, see phone-files.ts) and the last cloud list seen (for offline use).
import { cleanUrl, type ApiSong } from '../music-api';

export type PhoneSettings = {
  /** The music API's address, e.g. https://www.example.com/music-api */
  url: string;
  key: string;
  /** Shown as "added by" on uploads and as the owner of playlists made on the phone. */
  name: string;
  /** Off: the phone never connects to the cloud (saved songs still play). */
  online: boolean;
};

/**
 * A cloud song saved on the phone: `uri` is where it plays from. Saved into the Music folder: `mediaId` is its id in
 * Android's media index. Saved by an older version: `local` is its file name in the app's storage (moved on next look).
 */
export type SavedSong = ApiSong & { local: string; uri: string; mediaId?: number };

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEYS = { settings: 'musehik.cloud', saved: 'musehik.saved', last: 'musehik.lastSongs' };
const DEFAULTS: PhoneSettings = { url: '', key: '', name: '', online: true };

export class PhoneStore {
  private readonly storage: KeyValue;

  constructor(storage: KeyValue) {
    this.storage = storage;
  }

  private read<T>(key: string, fallback: T): T {
    try {
      const raw = this.storage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: the app keeps working, it just forgets */
    }
  }

  settings(): PhoneSettings {
    const stored = this.read<Partial<PhoneSettings>>(KEYS.settings, {});
    return {
      url: typeof stored.url === 'string' ? stored.url : '',
      key: typeof stored.key === 'string' ? stored.key : '',
      name: typeof stored.name === 'string' ? stored.name : '',
      online: stored.online !== false,
    };
  }

  /** An empty key keeps the saved one (the key is never shown again once saved). */
  saveSettings(patch: Partial<PhoneSettings>): PhoneSettings {
    const next = { ...DEFAULTS, ...this.settings() };
    if (patch.url !== undefined) next.url = cleanUrl(patch.url);
    if (patch.key) next.key = patch.key.trim();
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 60);
    if (patch.online !== undefined) next.online = patch.online;
    this.write(KEYS.settings, next);
    return next;
  }

  saved(): SavedSong[] {
    const list = this.read<SavedSong[]>(KEYS.saved, []);
    return Array.isArray(list) ? list : [];
  }

  findSaved(id: number): SavedSong | null {
    return this.saved().find((s) => s.id === id) ?? null;
  }

  isSaved(id: number): boolean {
    return this.findSaved(id) !== null;
  }

  addSaved(song: SavedSong): void {
    this.write(KEYS.saved, [...this.saved().filter((s) => s.id !== song.id), song].sort((a, b) => a.id - b.id));
  }

  /** After a rename on the cloud: the saved copy shows the new details too. */
  updateSaved(id: number, changes: Partial<ApiSong>): void {
    this.write(KEYS.saved, this.saved().map((s) => (s.id === id ? { ...s, ...changes, id, local: s.local, uri: s.uri, mediaId: s.mediaId } : s)));
  }

  /** Forgets a saved song and returns it (its file is for the caller to delete), or null. */
  removeSaved(id: number): SavedSong | null {
    const found = this.findSaved(id);
    if (found) this.write(KEYS.saved, this.saved().filter((s) => s.id !== id));
    return found;
  }

  lastSongs(): ApiSong[] {
    const list = this.read<ApiSong[]>(KEYS.last, []);
    return Array.isArray(list) ? list : [];
  }

  saveLastSongs(songs: ApiSong[]): void {
    this.write(KEYS.last, songs);
  }
}
