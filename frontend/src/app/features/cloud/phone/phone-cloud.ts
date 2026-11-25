// Everything the cloud pages need, done on the phone itself: the laptops ask their local server, the phone talks to
// the music API directly (music-api.ts) and keeps its own state (phone-store.ts). CloudService, LibraryService and
// PlaylistService hand their calls to this class when running as the Android app.
import type { Track } from '../../../core/api';
import type { CloudSettings, CloudSong, CloudStatus, SaveJob, UploadJob } from '../cloud.service';
import { MusicApiError, createMusicApi, type ApiPlaylist, type ApiPlaylistRef, type ApiSong, type MusicApi } from '../music-api';
import { runSave, runUpload, type Running, type SongTags } from './phone-jobs';
import { PhoneStore, type PhoneSettings, type SavedSong } from './phone-store';

/** A song in the phone's Music folder, as Android's media index lists it (`mine`: saved by this app). */
export type MusicFile = {
  id: number;
  uri: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  addedAt: string | null;
  size: number;
  mine: boolean;
};

/** The device side: files, the Music folder and tags (phone-files.ts; fakes in tests). */
export type PhoneDevice = {
  /** Into the app's storage (a download in progress never shows in the Music folder); returns the file's URI. */
  downloadSong: (url: string, local: string, expectedSize: number) => Promise<string>;
  deleteSongFile: (local: string) => Promise<void>;
  playable: (uri: string) => string;
  readTags: (file: File) => Promise<SongTags>;
  /** Every song in the phone's Music folder (copied by cable too). */
  listMusic: () => Promise<MusicFile[]>;
  /** Copies a file into Music/MuseHik under `name`. */
  saveToMusic: (from: string, name: string) => Promise<{ id: number; uri: string }>;
  /** Deletes a song from the Music folder (Android refuses for songs this app did not save). */
  deleteMusic: (id: number) => Promise<void>;
};

export const CABLE_DELETE = 'Delete songs copied by cable from your computer or the Files app.';

/** "Artist - Title.mp3", without the characters a file name cannot hold. */
function musicName(song: ApiSong): string {
  const ext = (song.file.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '.mp3').toLowerCase();
  const base = (song.artist ? `${song.artist} - ${song.title}` : song.title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return (base.slice(0, 150) || `Song ${song.id}`) + ext;
}

const WARN_AT = 0.8;
export const OFFLINE_MESSAGE = 'The cloud is off on this phone. Turn it on in Settings.';
const NOT_SET_UP = 'Set up the cloud in Settings first (address and key).';

export class PhoneCloud {
  readonly store: PhoneStore;
  private readonly device: PhoneDevice;
  private readonly makeApi: (s: PhoneSettings) => MusicApi;
  private uploadRun: Running<UploadJob> | null = null;
  private saveRun: Running<SaveJob> | null = null;
  /** Called when the phone's saved songs change (LibraryService reloads). */
  onSavedChange: () => void = () => {};

  constructor(store: PhoneStore, device: PhoneDevice, makeApi: (s: PhoneSettings) => MusicApi = createMusicApi) {
    this.store = store;
    this.device = device;
    this.makeApi = makeApi;
  }

  private api(): MusicApi {
    const s = this.store.settings();
    if (!s.url || !s.key) throw new Error(NOT_SET_UP);
    if (!s.online) throw new Error(OFFLINE_MESSAGE);
    return this.makeApi(s);
  }

  // ---- settings and status ----

  getSettings(): CloudSettings {
    const s = this.store.settings();
    return { url: s.url, cacheLimitGB: 0, online: s.online, hasKey: Boolean(s.key), name: s.name, displayName: s.name || 'Phone' };
  }

  saveSettings(patch: Partial<CloudSettings> & { key?: string }): CloudSettings {
    this.store.saveSettings({ url: patch.url, key: patch.key, name: patch.name, online: patch.online });
    return this.getSettings();
  }

  async testConnection(): Promise<{ ok: boolean; secure?: boolean; error?: string }> {
    try {
      const s = this.store.settings();
      if (!s.url || !s.key) return { ok: false, error: NOT_SET_UP };
      await this.makeApi(s).status();
      return { ok: true, secure: s.url.startsWith('https://') };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async status(): Promise<CloudStatus> {
    const s = this.store.settings();
    if (!s.url || !s.key) return { configured: false };
    if (!s.online) return { configured: true, online: false };
    const { storedBytes, storageLimitBytes } = await this.makeApi(s).status();
    return {
      configured: true, online: true, storedBytes, storageLimitBytes,
      percent: storageLimitBytes ? Math.min(100, Math.round((storedBytes / storageLimitBytes) * 1000) / 10) : 100,
      warning: storedBytes >= storageLimitBytes * WARN_AT,
    };
  }

  // ---- songs ----

  private withFlags(songs: ApiSong[]): CloudSong[] {
    return songs.map((s) => {
      const saved = this.store.isSaved(s.id);
      return { ...s, genre: s.genre ?? '', onLaptop: saved, inLibrary: saved };
    });
  }

  /** The cloud list (kept for offline use); the last one seen when off or unreachable. */
  async songs(): Promise<{ songs: CloudSong[]; offline: boolean; mode: 'online' | 'offline'; error?: string }> {
    const s = this.store.settings();
    if (!s.online) return { songs: this.withFlags(this.store.lastSongs()), offline: true, mode: 'offline' };
    try {
      const { songs } = await this.api().songs();
      this.store.saveLastSongs(songs);
      return { songs: this.withFlags(songs), offline: false, mode: 'online' };
    } catch (e) {
      return { songs: this.withFlags(this.store.lastSongs()), offline: true, mode: 'online', error: (e as Error).message };
    }
  }

  /** A cloud song as a player track: its saved file when on the phone, else streamed with the key. No covers. */
  toTrack(song: { id: number; title: string; artist: string; album: string; duration: number; addedAt?: string; genre?: string }): Track {
    const saved = this.store.findSaved(song.id);
    const s = this.store.settings();
    const stream = saved ? this.device.playable(saved.uri) : s.url && s.key ? this.makeApi(s).fileUrl(song.id) : '';
    return {
      id: -song.id, title: song.title, artist: song.artist, album: song.album, duration: song.duration,
      addedAt: song.addedAt ?? null, genre: song.genre ?? '', stream, cover: '',
    };
  }

  /**
   * "All tracks" on the phone: every song in its Music folder. The cloud songs saved there keep their cloud identity
   * (negative id: rename, playlists); the others (copied by cable) have their media index id. A saved song deleted
   * by cable is forgotten. Songs saved by an older version, in the app's storage, are moved into the Music folder.
   */
  async phoneTracks(): Promise<Track[]> {
    await this.moveOldSaves();
    let files: MusicFile[];
    try {
      files = await this.device.listMusic();
    } catch {
      return this.store.saved().map((s) => ({ ...this.toTrack(s), size: s.size })); // cannot look: show what we know
    }
    const byMedia = new Map(this.store.saved().filter((s) => s.mediaId !== undefined).map((s) => [s.mediaId!, s]));
    const present = new Set(files.map((f) => f.id));
    for (const s of byMedia.values()) if (!present.has(s.mediaId!)) this.store.removeSaved(s.id);
    return files.map((f) => {
      const saved = byMedia.get(f.id);
      if (saved) return { ...this.toTrack(saved), size: saved.size };
      return {
        id: f.id, title: f.title, artist: f.artist, album: f.album, duration: f.duration, size: f.size,
        addedAt: f.addedAt, genre: '', stream: this.device.playable(f.uri), cover: '',
      };
    });
  }

  private moving: Promise<void> | null = null;

  private moveOldSaves(): Promise<void> {
    this.moving ??= this.moveOldSavesNow().finally(() => (this.moving = null));
    return this.moving;
  }

  private async moveOldSavesNow(): Promise<void> {
    for (const s of this.store.saved()) {
      if (s.mediaId !== undefined || !s.local) continue;
      try {
        const { id, uri } = await this.device.saveToMusic(s.uri, musicName(s));
        this.store.addSaved({ ...s, local: '', uri, mediaId: id });
        await this.device.deleteSongFile(s.local);
      } catch {
        /* stays where it is and still plays; tried again next time */
      }
    }
  }

  /** Deletes a song of the Music folder that is not a cloud song (a song copied by cable cannot be: says where). */
  async deleteFromPhone(mediaId: number): Promise<void> {
    try {
      await this.device.deleteMusic(mediaId);
    } catch {
      throw new Error(CABLE_DELETE);
    }
    this.onSavedChange();
  }

  async editSong(id: number, changes: { title?: string; artist?: string; genre?: string }): Promise<CloudSong> {
    let after: ApiSong;
    try {
      after = await this.api().editSong(id, changes);
    } catch (e) {
      if ((e as MusicApiError).status === 404) throw new Error('This song is not on the cloud.');
      throw e;
    }
    if (this.store.isSaved(id)) {
      this.store.updateSaved(id, after);
      this.onSavedChange();
    }
    this.store.saveLastSongs(this.store.lastSongs().map((s) => (s.id === id ? after : s)));
    return this.withFlags([after])[0];
  }

  /** Deletes it from the cloud for everyone. A copy saved on this phone stays (like the laptops' library copy). */
  async deleteSong(id: number): Promise<void> {
    if (!(await this.api().deleteSong(id))) throw new Error('This song is not on the cloud.');
    this.store.saveLastSongs(this.store.lastSongs().filter((s) => s.id !== id));
  }

  /** Removes the copy saved on this phone (the cloud keeps the song). */
  async removeFromPhone(id: number): Promise<void> {
    const saved = this.store.findSaved(id);
    if (saved?.mediaId !== undefined) {
      try {
        await this.device.deleteMusic(saved.mediaId);
      } catch {
        throw new Error('Could not delete it from this phone.');
      }
    } else if (saved?.local) await this.device.deleteSongFile(saved.local);
    this.store.removeSaved(id);
    this.onSavedChange();
  }

  /** Downloads into the app's storage first (checked complete), then moves it into Music/MuseHik. */
  private async saveOne(song: ApiSong): Promise<void> {
    const name = musicName(song);
    const local = `${song.id}${name.slice(name.lastIndexOf('.'))}`;
    const downloaded = await this.device.downloadSong(this.api().fileUrl(song.id), local, song.size);
    try {
      const { id, uri } = await this.device.saveToMusic(downloaded, name);
      this.store.addSaved({ ...song, local: '', uri, mediaId: id } satisfies SavedSong);
    } finally {
      await this.device.deleteSongFile(local);
    }
    this.onSavedChange();
  }

  /** The tags of a file picked on the phone (null when unreadable). */
  async readTags(file: File): Promise<SongTags | null> {
    return this.device.readTags(file).catch(() => null);
  }

  // ---- jobs ----

  startUpload(files: File[]): { jobId: string } {
    if (this.uploadRun?.job.state === 'running') throw new Error('An upload is already running.');
    const api = this.api();
    const s = this.store.settings();
    this.uploadRun = runUpload(files, { api, readTags: this.device.readTags, addedBy: s.name || 'Phone' });
    return { jobId: this.uploadRun.job.id };
  }

  private snapshot<J extends UploadJob | SaveJob>(run: Running<J> | null, id?: string): J | null {
    if (!run || (id !== undefined && run.job.id !== id)) return null;
    return structuredClone(run.job);
  }

  getUpload(id: string): UploadJob | null {
    return this.snapshot(this.uploadRun, id);
  }
  activeUpload(): UploadJob | null {
    return this.uploadRun?.job.state === 'running' ? this.snapshot(this.uploadRun) : null;
  }
  cancelUpload(id: string): UploadJob | null {
    if (this.uploadRun?.job.id === id) this.uploadRun.cancel();
    return this.getUpload(id);
  }

  async startSave(ids: number[]): Promise<{ jobId: string }> {
    if (this.saveRun?.job.state === 'running') throw new Error('Songs are already being saved.');
    // The API's own entries (CloudSong is the same object plus the "on this phone" flags).
    const songs = (await this.songs()).songs as unknown as ApiSong[];
    this.saveRun = runSave(ids, { songs, isSaved: (id) => this.store.isSaved(id), save: (song) => this.saveOne(song) });
    return { jobId: this.saveRun.job.id };
  }
  getSave(id: string): SaveJob | null {
    return this.snapshot(this.saveRun, id);
  }
  activeSave(): SaveJob | null {
    return this.saveRun?.job.state === 'running' ? this.snapshot(this.saveRun) : null;
  }
  cancelSave(id: string): SaveJob | null {
    if (this.saveRun?.job.id === id) this.saveRun.cancel();
    return this.getSave(id);
  }

  // ---- playlists (all on the cloud, so all shared) ----

  playlists(): Promise<ApiPlaylist[]> {
    return this.api().playlists();
  }
  createPlaylist(name: string, songs: ApiPlaylistRef[]): Promise<ApiPlaylist> {
    return this.api().createPlaylist({ name, owner: this.getSettings().displayName, songs });
  }
  updatePlaylist(uid: string, name: string, songs: ApiPlaylistRef[]): Promise<ApiPlaylist> {
    return this.api().updatePlaylist(uid, { name, songs });
  }
  deletePlaylist(uid: string): Promise<void> {
    return this.api().deletePlaylist(uid);
  }
}
