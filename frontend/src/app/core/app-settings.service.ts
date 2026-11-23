import { Injectable, computed, signal } from '@angular/core';
import { API } from './api';
import { desktop } from './desktop';

export type Profile = 'poontje' | 'muttmutt';

/** GET /api/app */
export type AppInfo = {
  profile: Profile;
  musicDir: string;
  songs: number;
  /** Running as the installed Windows app (not from the code folder). */
  installed: boolean;
  version: string | null;
};

/** POST /api/app/music-folder */
export type FolderChange = { musicDir: string; moved: number; failed: { file: string; error: string }[]; total: number };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}/app${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Server error ${response.status}`);
  return body as T;
}

/** Who uses this laptop (Poontje sees the AI tools, MuttMutt does not) and where the music is. */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  readonly info = signal<AppInfo | null>(null);
  /** False until loaded, so MuttMutt never sees the AI tools flash by. */
  readonly aiAllowed = computed(() => this.info()?.profile === 'poontje');

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      this.info.set(await call<AppInfo>(''));
    } catch {
      /* server not reachable: the pages show their own errors */
    }
  }

  async setProfile(profile: Profile): Promise<void> {
    this.info.set(await call<AppInfo>('/profile', { method: 'PUT', body: JSON.stringify({ profile }) }));
  }

  /** The native folder window in the desktop app; in a browser, the server opens the Windows one. */
  async pickFolder(): Promise<string | null> {
    if (desktop) return desktop.pickFolder();
    return (await call<{ path: string | null }>('/music-folder/pick', { method: 'POST' })).path;
  }

  async changeMusicDir(path: string, move: boolean): Promise<FolderChange> {
    const result = await call<FolderChange>('/music-folder', { method: 'POST', body: JSON.stringify({ path, move }) });
    await this.load();
    return result;
  }
}
