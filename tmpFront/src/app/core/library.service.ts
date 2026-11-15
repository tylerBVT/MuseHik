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
      this.error.set('Cannot reach the MuseHik server. Is it running (node server.mjs in tmpBack)?');
    } finally {
      this.loading.set(false);
    }
  }
}
