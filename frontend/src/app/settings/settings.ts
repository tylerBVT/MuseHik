import { Component, inject, signal } from '@angular/core';
import { PageHeader } from '../shared/page-header';
import { ThemeChoice, ThemeService } from '../core/theme.service';
import { API } from '../core/api';
import { CloudService, CloudSettings } from '../features/cloud/cloud.service';

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
  protected readonly cloudPassword = signal('');
  protected readonly cloudBusy = signal(false);
  protected readonly cloudResult = signal<{ ok: boolean; text: string } | null>(null);

  constructor() {
    void this.loadEngine();
    void this.loadCloud();
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

  /** Saves the form, then tries to connect with it. */
  protected async saveAndTestCloud(): Promise<void> {
    const form = this.cloudForm();
    if (!form) return;
    this.cloudBusy.set(true);
    this.cloudResult.set(null);
    try {
      const { hasPassword: _, displayName: __, ...fields } = form;
      const saved = await this.cloud.saveSettings({ ...fields, password: this.cloudPassword() || undefined });
      this.cloudForm.set(saved);
      this.cloudPassword.set('');
      const test = await this.cloud.testConnection();
      this.cloudResult.set(
        test.ok
          ? { ok: true, text: test.secure ? 'Connected (encrypted, FTPS).' : 'Connected, without encryption (plain FTP).' }
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
