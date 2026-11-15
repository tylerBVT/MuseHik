import { Injectable, signal } from '@angular/core';
import { API, Track } from './api';

export type PlaylistSummary = { id: number; name: string; count: number };
export type Playlist = { id: number; name: string; tracks: Track[] };

/** Playlists stored by the server (a name plus an ordered list of library songs). */
@Injectable({ providedIn: 'root' })
export class PlaylistService {
  readonly playlists = signal<PlaylistSummary[]>([]);

  async load(): Promise<void> {
    try {
      const response = await fetch(`${API}/playlists`);
      if (response.ok) this.playlists.set(await response.json());
    } catch {
      /* server unreachable: the library notice already says so */
    }
  }

  async get(id: number): Promise<Playlist | null> {
    try {
      const response = await fetch(`${API}/playlists/${id}`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  create(name: string, trackIds: number[]): Promise<Playlist> {
    return this.send('POST', '/playlists', { name, trackIds });
  }

  update(id: number, name: string, trackIds: number[]): Promise<Playlist> {
    return this.send('PUT', `/playlists/${id}`, { name, trackIds });
  }

  async remove(id: number): Promise<void> {
    await this.send('DELETE', `/playlists/${id}`);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `Server error ${response.status}`);
    await this.load();
    return data as T;
  }
}
