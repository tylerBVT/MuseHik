import { Component, inject, signal } from '@angular/core';
import { PageHeader } from '../shared/page-header';
import { ThemeChoice, ThemeService } from '../core/theme.service';
import { API } from '../core/api';

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

  constructor() {
    void this.loadEngine();
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
