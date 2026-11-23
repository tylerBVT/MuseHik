import { Injectable, signal } from '@angular/core';
import { API, Track, cloudTrack } from '../../core/api';
import type { SongChanges } from '../../core/library.service';

export type CloudSettings = {
  host: string;
  port: number;
  user: string;
  folder: string;
  storageLimitGB: number;
  cacheLimitGB: number;
  allowPlainFtp: boolean;
  /** Off: this laptop never connects to the cloud (songs already on it still play). */
  online: boolean;
  hasPassword: boolean;
  /** Shown on playlists you share. */
  name: string;
  /** `name`, or the computer's name when empty (read only). */
  displayName: string;
};

/** GET /api/cloud/status: what the usage bar shows. `percent` and `warning` are about storage. */
export type CloudStatus = {
  configured: boolean;
  /** false: switched to Offline in Settings (nothing else is sent then). */
  online?: boolean;
  error?: string;
  percent?: number;
  warning?: boolean;
  storedBytes?: number;
  storageLimitBytes?: number;
};

export type CloudSong = {
  id: number;
  file: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  size: number;
  addedBy: string;
  addedAt: string;
  genre?: string;
  /** Plays without the network: the same song is in this laptop's library, or in the cloud cache. */
  onLaptop: boolean;
  /** The same song is in this laptop's library. */
  inLibrary: boolean;
};

export type FolderSong = { path: string; title: string; artist: string; album: string; duration: number; size: number };

export type UploadItem = { title: string; artist: string; file: string; reason?: string };
export type UploadJob = {
  id: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  done: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null;
  uploaded: UploadItem[];
  skipped: UploadItem[];
  failed: UploadItem[];
  error: string | null;
};

export type SaveItem = { id: number; title: string; artist: string; file?: string; reason?: string };
/** "Download from cloud": cloud songs being copied into this laptop's music folder. */
export type SaveJob = {
  id: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  done: number;
  current: string | null;
  saved: SaveItem[];
  skipped: SaveItem[];
  failed: SaveItem[];
  error: string | null;
};

/** Set up, and switched to Online on this laptop. */
export function cloudOnline(s: CloudSettings | null): boolean {
  return Boolean(s && s.host && s.user && s.hasPassword && s.online !== false);
}

/** "410 MB", "3.2 GB" (1 GB = 1000 MB, like the hosting counts). */
export function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${Number((bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1))} GB`;
}

/** Talks to the local server's /api/cloud (which does the FTP work). */
@Injectable({ providedIn: 'root' })
export class CloudService {
  readonly status = signal<CloudStatus | null>(null);
  /** The last settings read or saved (null until a page asks for them). */
  readonly settings = signal<CloudSettings | null>(null);

  async loadStatus(): Promise<void> {
    try {
      this.status.set(await this.call<CloudStatus>('GET', '/status'));
    } catch (e) {
      this.status.set({ configured: true, error: (e as Error).message });
    }
  }

  /** `mode` 'offline': switched off on this laptop; `offline` alone: the cloud could not be reached. */
  songs(): Promise<{ songs: CloudSong[]; offline: boolean; mode?: 'online' | 'offline'; error?: string }> {
    return this.call('GET', '/songs');
  }

  /** A cloud song as a player track. Negative ids never clash with library ids. */
  toTrack(song: CloudSong): Track {
    return cloudTrack(song);
  }

  deleteSong(id: number): Promise<unknown> {
    return this.call('DELETE', `/songs/${id}`);
  }

  /** Song menu: new title, artist and/or genre in the shared list (the cloud file is renamed to match). */
  editSong(id: number, changes: SongChanges): Promise<CloudSong> {
    return this.call('PATCH', `/songs/${id}`, changes);
  }

  /** Uploads these library songs, after the upload running now if there is one. */
  queueUpload(trackIds: number[]): Promise<{ jobId?: string; queued?: boolean }> {
    return this.call('POST', '/upload', { trackIds, queue: true });
  }

  async getSettings(): Promise<CloudSettings> {
    const settings = await this.call<CloudSettings>('GET', '/settings');
    this.settings.set(settings);
    return settings;
  }
  async saveSettings(patch: Partial<Omit<CloudSettings, 'displayName'>> & { password?: string }): Promise<CloudSettings> {
    const settings = await this.call<CloudSettings>('PUT', '/settings', patch);
    this.settings.set(settings);
    return settings;
  }
  testConnection(): Promise<{ ok: boolean; secure?: boolean; error?: string }> {
    return this.call('POST', '/test');
  }

  pickFolder(): Promise<{ path: string | null }> {
    return this.call('POST', '/folder/pick');
  }
  scanFolder(path: string): Promise<{ songs: FolderSong[] }> {
    return this.call('POST', '/folder/scan', { path });
  }

  startUpload(selection: { trackIds?: number[]; paths?: string[] }): Promise<{ jobId: string }> {
    return this.call('POST', '/upload', selection);
  }
  getUpload(id: string): Promise<UploadJob> {
    return this.call('GET', `/upload/${id}`);
  }
  activeUpload(): Promise<UploadJob | null> {
    return this.call('GET', '/upload/active');
  }
  cancelUpload(id: string): Promise<UploadJob> {
    return this.call('POST', `/upload/${id}/cancel`);
  }

  startSave(ids: number[]): Promise<{ jobId: string }> {
    return this.call('POST', '/save', { ids });
  }
  getSave(id: string): Promise<SaveJob> {
    return this.call('GET', `/save/${id}`);
  }
  activeSave(): Promise<SaveJob | null> {
    return this.call('GET', '/save/active');
  }
  cancelSave(id: string): Promise<SaveJob> {
    return this.call('POST', `/save/${id}/cancel`);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}/cloud${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Cannot reach the MuseHik server.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `Server error ${response.status}`);
    return data as T;
  }
}
