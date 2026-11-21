import { Injectable, signal } from '@angular/core';
import { API, Track, cloudTrack } from '../../core/api';

export type PlaylistSummary = { id: number; uid: string; name: string; count: number; shared: boolean; owner: string };

/** A song of a playlist, stored by identity; `trackId` / `cloudId` say where it plays from (null = nowhere). */
export type PlaylistSong = {
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc: string | null;
  key: string;
  trackId: number | null;
  cloudId: number | null;
};

export type Playlist = {
  id: number;
  uid: string;
  name: string;
  shared: boolean;
  /** Who shared it (empty for a playlist never shared). */
  owner: string;
  songs: PlaylistSong[];
  /** Only the songs in this laptop's library (what older pages use). */
  tracks: Track[];
};

/** What the editor sends: a library song, a cloud song, or a song kept by identity. */
export type SongRef = { trackId: number } | { cloudId: number } | PlaylistSong;

/** The playlist as player tracks: library songs, cloud songs, and unavailable ones (greyed, never played). */
export function toTracks(songs: PlaylistSong[]): Track[] {
  return songs.map((song, i) => {
    if (song.trackId !== null) {
      return { id: song.trackId, title: song.title, artist: song.artist, album: song.album, duration: song.duration };
    }
    if (song.cloudId !== null) return cloudTrack({ ...song, id: song.cloudId });
    return {
      id: -(1_000_000_000 + i),
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      unavailable: true,
    };
  });
}

/** Playlists stored by the server; shared ones are also kept in step with the cloud by the server. */
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

  /** Asks the server to sync shared playlists with the cloud (it skips if it did so in the last 30 s). */
  async sync(): Promise<void> {
    try {
      await fetch(`${API}/cloud/playlists/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch {
      /* offline: the local playlists are still there */
    }
    await this.load();
  }

  async get(id: number): Promise<Playlist | null> {
    try {
      const response = await fetch(`${API}/playlists/${id}`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  create(name: string, songs: SongRef[] | number[]): Promise<Playlist> {
    return this.send('POST', '/playlists', { name, songs });
  }

  update(id: number, name: string, songs: SongRef[] | number[]): Promise<Playlist> {
    return this.send('PUT', `/playlists/${id}`, { name, songs });
  }

  setShared(id: number, shared: boolean): Promise<Playlist> {
    return this.send('PUT', `/cloud/playlists/${id}/share`, { shared });
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
