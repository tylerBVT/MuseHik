import { Component, inject, signal } from '@angular/core';
import { PageHeader } from '../shared/page-header';
import { ThemeChoice, ThemeService } from '../core/theme.service';
import { API } from '../core/api';
import { CloudService, CloudSettings } from '../features/cloud/cloud.service';
import { AppSettingsService, Profile } from '../core/app-settings.service';
import { desktop } from '../core/desktop';
import { LibraryService } from '../core/library.service';
import { deviceName, hasServer } from '../core/platform';

/** yt-dlp, the downloader's engine, as reported by GET /api/download/engine. */
type Engine = {
  ytdlp: string | null;
  ejs: string | null;
  channel: 'stable' | 'nightly';
  lastCheck: string | null;
  lastResult: { ok: boolean; message: string; reason: string; at: string } | null;
  previousVersion: string | null;
  updating: boolean;
  youtubeBlockedUntil: number | null;
};

@Component({
  imports: [PageHeader],
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  protected readonly theme = inject(ThemeService);

  protected readonly themes: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  protected readonly channels: { value: Engine['channel']; label: string }[] = [
    { value: 'stable', label: 'Stable' },
    { value: 'nightly', label: 'Nightly' },
  ];

  protected readonly engine = signal<Engine | null>(null);
  protected readonly engineError = signal('');

  private readonly cloud = inject(CloudService);
  /** The cloud form (the password field stays empty: the saved one is kept unless a new one is typed). */
  protected readonly cloudForm = signal<CloudSettings | null>(null);
  /** The API key being typed (the saved one never comes back to the page). */
  protected readonly cloudKey = signal('');
  protected readonly cloudBusy = signal(false);
  protected readonly cloudResult = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly app = inject(AppSettingsService);
  private readonly library = inject(LibraryService);
  protected readonly profiles: { value: Profile; label: string }[] = [
    { value: 'poontje', label: 'Poontje' },
    { value: 'muttmutt', label: 'MuttMutt' },
  ];
  protected readonly profileError = signal('');
  /** A folder picked in the window, waiting for "move my songs" or "use it as it is". */
  protected readonly pickedFolder = signal<string | null>(null);
  protected readonly folderBusy = signal(false);
  protected readonly folderResult = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly isDesktop = Boolean(desktop);
  protected readonly updateText = signal('');
  protected readonly updateChecking = signal(false);

  /** False on the phone: only the sections that work without the laptop's server are shown. */
  protected readonly hasServer = hasServer;
  protected readonly device = deviceName;

  constructor() {
    void this.loadCloud();
    if (!hasServer) return;
    void this.loadEngine();
    void this.app.load();
  }

  protected async setProfile(profile: Profile): Promise<void> {
    this.profileError.set('');
    try {
      await this.app.setProfile(profile);
    } catch (e) {
      this.profileError.set((e as Error).message);
    }
  }

  protected async pickMusicFolder(): Promise<void> {
    this.folderResult.set(null);
    try {
      const path = await this.app.pickFolder();
      if (path) this.pickedFolder.set(path);
    } catch (e) {
      this.folderResult.set({ ok: false, text: (e as Error).message });
    }
  }

  /** "Move my N songs there" (move) or "Use this folder as it is". */
  protected async useMusicFolder(move: boolean): Promise<void> {
    const path = this.pickedFolder();
    if (!path) return;
    const old = this.app.info()?.musicDir ?? '';
    this.folderBusy.set(true);
    this.folderResult.set(null);
    try {
      const result = await this.app.changeMusicDir(path, move);
      this.pickedFolder.set(null);
      const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;
      this.folderResult.set(
        result.failed.length
          ? { ok: false, text: `${songs(result.failed.length)} could not be moved; they are still in ${old}.` }
          : { ok: true, text: move ? `Moved ${songs(result.moved)}.` : `Now using this folder: ${songs(result.total)}.` },
      );
      void this.library.load();
    } catch (e) {
      this.folderResult.set({ ok: false, text: (e as Error).message });
    } finally {
      this.folderBusy.set(false);
    }
  }

  protected async checkForUpdates(): Promise<void> {
    if (!desktop) return;
    this.updateChecking.set(true);
    try {
      const r = await desktop.checkForUpdates();
      this.updateText.set(
        r.status === 'latest' ? 'You have the latest version.'
        : r.status === 'downloading' ? `Downloading version ${r.version}...`
        : r.status === 'ready' ? `Version ${r.version} is ready, restart to install.`
        : (r.message ?? 'Could not check for updates.'),
      );
    } finally {
      this.updateChecking.set(false);
    }
  }

  private async loadCloud(): Promise<void> {
    try {
      this.cloudForm.set(await this.cloud.getSettings());
    } catch (e) {
      this.cloudResult.set({ ok: false, text: (e as Error).message });
    }
  }

  protected setCloud<K extends keyof CloudSettings>(key: K, value: CloudSettings[K]): void {
    this.cloudForm.update((form) => (form ? { ...form, [key]: value } : form));
    this.cloudResult.set(null);
  }

  /** The Online / Offline switch: saved at once (nothing else in the form is saved). */
  protected async setOnline(online: boolean): Promise<void> {
    this.cloudBusy.set(true);
    this.cloudResult.set(null);
    try {
      const saved = await this.cloud.saveSettings({ online });
      this.cloudForm.update((form) => (form ? { ...form, online: saved.online } : saved));
      this.cloudResult.set({ ok: true, text: `The cloud is ${online ? 'on' : 'off'} for this ${deviceName}.` });
      void this.cloud.loadStatus();
    } catch (e) {
      this.cloudResult.set({ ok: false, text: (e as Error).message });
    } finally {
      this.cloudBusy.set(false);
    }
  }

  /** Saves the form, then tries to connect with it. */
  protected async saveAndTestCloud(): Promise<void> {
    const form = this.cloudForm();
    if (!form) return;
    this.cloudBusy.set(true);
    this.cloudResult.set(null);
    try {
      const { hasKey: _, displayName: __, ...fields } = form;
      const saved = await this.cloud.saveSettings({ ...fields, key: this.cloudKey() || undefined });
      this.cloudForm.set(saved);
      this.cloudKey.set('');
      const test = await this.cloud.testConnection();
      this.cloudResult.set(
        test.ok
          ? { ok: true, text: test.secure ? 'Connected (encrypted, HTTPS).' : 'Connected, without encryption (http).' }
          : { ok: false, text: test.error ?? 'Could not connect.' },
      );
      void this.cloud.loadStatus();
    } catch (e) {
      this.cloudResult.set({ ok: false, text: (e as Error).message });
    } finally {
      this.cloudBusy.set(false);
    }
  }

  protected async loadEngine(): Promise<void> {
    try {
      const response = await fetch(`${API}/download/engine`);
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      this.engine.set(await response.json());
      this.engineError.set('');
    } catch {
      this.engineError.set('Cannot reach the MuseHik server.');
    }
  }

  protected async setChannel(channel: Engine['channel']): Promise<void> {
    await this.call('', { method: 'PUT', body: JSON.stringify({ channel }) });
  }

  protected async updateNow(): Promise<void> {
    await this.call('/update', { method: 'POST' });
  }

  protected async rollback(): Promise<void> {
    await this.call('/rollback', { method: 'POST' });
  }

  /** Sends an engine action, then follows a running update until it ends. */
  private async call(path: string, init: RequestInit): Promise<void> {
    try {
      const response = await fetch(`${API}/download/engine${path}`, {
        ...init, headers: { 'Content-Type': 'application/json' },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Server error ${response.status}`);
      this.engine.set(body);
      this.engineError.set('');
    } catch (e) {
      this.engineError.set((e as Error).message);
      return;
    }
    // Update/rollback run in the background (pip takes ~10 s): poll until done.
    for (let i = 0; i < 600 && path; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.loadEngine();
      if (!this.engine()?.updating) break;
    }
  }

  protected when(iso: string | number | null): string {
    if (!iso) return 'never';
    return new Date(iso).toLocaleString([], {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }
}
