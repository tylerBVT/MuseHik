import { Injectable, signal } from '@angular/core';
import { API, Track } from '../../core/api';

export type CloudSettings = {
  host: string;
  port: number;
  user: string;
  folder: string;
  monthlyLimitGB: number;
  storageLimitGB: number;
  cacheLimitGB: number;
  allowPlainFtp: boolean;
  hasPassword: boolean;
};

/** GET /api/cloud/status: what the usage bars show. */
export type CloudStatus = {
  configured: boolean;
  error?: string;
  month?: string;
  usedBytes?: number;
  limitBytes?: number;
  percent?: number;
  warning?: boolean;
  reached?: boolean;
  storedBytes?: number;
  storageLimitBytes?: number;
  message?: string | null;
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
  /** Plays without the network: the same song is in this laptop's library, or in the cloud cache. */
  onLaptop: boolean;
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

/** "410 MB", "3.2 GB" (1 GB = 1000 MB, like the hosting counts). */
export function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1)} GB`;
}

/** Talks to the local server's /api/cloud (which does the FTP work). */
@Injectable({ providedIn: 'root' })
export class CloudService {
  readonly status = signal<CloudStatus | null>(null);

  async loadStatus(): Promise<void> {
    try {
      this.status.set(await this.call<CloudStatus>('GET', '/status'));
    } catch (e) {
      this.status.set({ configured: true, error: (e as Error).message });
    }
  }

  songs(): Promise<{ songs: CloudSong[]; offline: boolean; error?: string }> {
    return this.call('GET', '/songs');
  }

  /** A cloud song as a player track. Negative ids never clash with library ids. */
  toTrack(song: CloudSong): Track {
    const base = `${API}/cloud/songs/${song.id}`;
    return {
      id: -song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      stream: `${base}/stream`,
      cover: `${base}/cover`,
      prefetch: `${base}/prefetch`,
    };
  }

  deleteSong(id: number): Promise<unknown> {
    return this.call('DELETE', `/songs/${id}`);
  }

  getSettings(): Promise<CloudSettings> {
    return this.call('GET', '/settings');
  }
  saveSettings(patch: Partial<CloudSettings> & { password?: string }): Promise<CloudSettings> {
    return this.call('PUT', '/settings', patch);
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
