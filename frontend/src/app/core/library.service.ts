import { Injectable, signal } from '@angular/core';
import { API, Track } from './api';

/** The song list from the server's SQLite library index. */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  readonly tracks = signal<Track[]>([]);
  readonly loading = signal(false);
  /** Set when the server cannot be reached, so the page can say so instead of showing an empty library. */
  readonly error = signal<string | null>(null);

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const response = await fetch(`${API}/library`);
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      this.tracks.set(await response.json());
      this.error.set(null);
    } catch {
      this.error.set('Cannot reach the MuseHik server. Is it running (node server.mjs in backend)?');
    } finally {
      this.loading.set(false);
    }
  }

  /** Song menu: new title, artist and/or genre (written into the file, which is renamed to match). */
  async edit(id: number, changes: SongChanges): Promise<Track> {
    const track = await send<Track>('PATCH', `/library/${id}`, changes);
    this.tracks.update((list) => list.map((t) => (t.id === id ? { ...t, ...track } : t)));
    return track;
  }

  /** Song menu: the file goes to the Recycle Bin. */
  async remove(id: number): Promise<void> {
    await send('DELETE', `/library/${id}`);
    this.tracks.update((list) => list.filter((t) => t.id !== id));
  }
}

/** What the song menu can change. Only the fields the person changed are sent. */
export type SongChanges = { title?: string; artist?: string; genre?: string };

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
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
