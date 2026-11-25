import { Injectable, signal } from '@angular/core';
import { API, Track, cloudTrack } from '../../core/api';
import { phoneCloud } from '../cloud/phone';
import type { ApiPlaylist, ApiPlaylistRef } from '../cloud/music-api';

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

/** The phone's playlists are the cloud's (all shared); the pages use numbers as ids, the cloud uses uids. */
const phoneIds = new Map<string, number>();
const phoneUid = (id: number) => [...phoneIds].find(([, n]) => n === id)?.[0] ?? null;
function phoneId(uid: string): number {
  if (!phoneIds.has(uid)) phoneIds.set(uid, phoneIds.size + 1);
  return phoneIds.get(uid)!;
}

function fromCloud(p: ApiPlaylist): Playlist {
  const songs: PlaylistSong[] = p.songs.map((s) => ({
    title: s.title, artist: s.artist, album: s.album ?? '', duration: s.duration ?? 0, isrc: s.isrc ?? null, key: s.key ?? '',
    trackId: null, cloudId: s.songId,
  }));
  return { id: phoneId(p.id), uid: p.id, name: p.name, shared: true, owner: p.owner, songs, tracks: [] };
}

/** What the editor picked, as the cloud wants it: a cloud song by id, or a song kept by its details. */
function toCloudRefs(songs: SongRef[] | number[]): ApiPlaylistRef[] {
  return (songs as (SongRef | number)[]).flatMap((ref): ApiPlaylistRef[] => {
    if (typeof ref === 'number') return [{ id: -ref }];
    if ('cloudId' in ref && ref.cloudId !== null && !('title' in ref)) return [{ id: ref.cloudId }];
    if ('trackId' in ref && !('title' in ref)) return ref.trackId < 0 ? [{ id: -ref.trackId }] : [];
    const song = ref as PlaylistSong;
    if (song.cloudId !== null) return [{ id: song.cloudId }];
    return [{ title: song.title, artist: song.artist, album: song.album, duration: song.duration, isrc: song.isrc, key: song.key }];
  });
}

/**
 * Laptop: playlists stored by the server; shared ones are also kept in step with the cloud by the server.
 * Phone: the cloud's playlists, straight from the music API.
 */
@Injectable({ providedIn: 'root' })
export class PlaylistService {
  readonly playlists = signal<PlaylistSummary[]>([]);
  /** Phone: the last playlists read from the cloud. */
  private phoneList: Playlist[] = [];

  async load(): Promise<void> {
    if (phoneCloud) {
      try {
        this.phoneList = (await phoneCloud.playlists()).map(fromCloud);
      } catch {
        /* no cloud right now: keep the last list */
      }
      this.playlists.set(this.phoneList.map((p) => ({ id: p.id, uid: p.uid, name: p.name, count: p.songs.length, shared: true, owner: p.owner })));
      return;
    }
    try {
      const response = await fetch(`${API}/playlists`);
      if (response.ok) this.playlists.set(await response.json());
    } catch {
      /* server unreachable: the library notice already says so */
    }
  }

  /** Asks the server to sync shared playlists with the cloud (it skips if it did so in the last 30 s). */
  async sync(): Promise<void> {
    if (phoneCloud) return this.load();
    try {
      await fetch(`${API}/cloud/playlists/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch {
      /* offline: the local playlists are still there */
    }
    await this.load();
  }

  async get(id: number): Promise<Playlist | null> {
    if (phoneCloud) {
      await this.load();
      return this.phoneList.find((p) => p.id === id) ?? null;
    }
    try {
      const response = await fetch(`${API}/playlists/${id}`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  async create(name: string, songs: SongRef[] | number[]): Promise<Playlist> {
    if (phoneCloud) {
      const made = fromCloud(await phoneCloud.createPlaylist(name, toCloudRefs(songs)));
      await this.load();
      return made;
    }
    return this.send('POST', '/playlists', { name, songs });
  }

  async update(id: number, name: string, songs: SongRef[] | number[]): Promise<Playlist> {
    if (phoneCloud) {
      const uid = phoneUid(id);
      if (!uid) throw new Error('This playlist does not exist any more.');
      const updated = fromCloud(await phoneCloud.updatePlaylist(uid, name, toCloudRefs(songs)));
      await this.load();
      return updated;
    }
    return this.send('PUT', `/playlists/${id}`, { name, songs });
  }

  setShared(id: number, shared: boolean): Promise<Playlist> {
    return this.send('PUT', `/cloud/playlists/${id}/share`, { shared });
  }

  async remove(id: number): Promise<void> {
    if (phoneCloud) {
      const uid = phoneUid(id);
      if (uid) await phoneCloud.deletePlaylist(uid);
      await this.load();
      return;
    }
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
