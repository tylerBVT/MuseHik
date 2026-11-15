import { Component, computed, output, signal } from '@angular/core';
import { API } from '../core/api';

type Toast = { kind: 'info' | 'success' | 'error'; text: string };

type Job = {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  name: string;
  total: number;
  done: number;
  skipped: number;
  current: string;
  files: string[];
  skippedList: { track: string; reason: string }[];
  failed: { track: string; error: string }[];
  warning?: string;
  error?: string;
};

const POLL_MS = 1000;

@Component({
  selector: 'app-link-input',
  templateUrl: './link-input.html',
  styleUrl: './link-input.css',
})
export class LinkInput {
  protected readonly link = signal('');
  protected readonly downloading = signal(false);
  protected readonly toast = signal<Toast | null>(null);
  /** Latest state of the running download (null when idle). Drives the progress bar. */
  protected readonly job = signal<Job | null>(null);
  protected readonly stopping = signal(false);
  /** Result of the last finished download (kept on screen with expandable lists). */
  protected readonly summary = signal<Job | null>(null);
  /** Emitted when a download ends, so the library list can refresh. */
  readonly finished = output<void>();

  protected readonly canDownload = computed(
    () => this.link().trim().length > 0 && !this.downloading(),
  );
  /** 0-100, or null while the playlist length is still unknown (shows a moving "busy" bar). */
  protected readonly percent = computed(() => {
    const job = this.job();
    return job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  });

  private toastTimer?: ReturnType<typeof setTimeout>;

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
  }

  protected async download(): Promise<void> {
    if (!this.canDownload()) return;
    this.downloading.set(true);
    this.stopping.set(false);
    this.dismissToast();
    this.summary.set(null);
    this.job.set({
      id: '', status: 'running', name: '', total: 0, done: 0, skipped: 0,
      current: 'Starting...', files: [], skippedList: [], failed: [],
    });
    try {
      const start = await fetch(`${API}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: this.link().trim() }),
      });
      const started = await start.json();
      if (!start.ok) throw new Error(started.error ?? `Server error ${start.status}`);
      await this.follow(started.jobId);
    } catch (e) {
      const message =
        e instanceof TypeError
          ? 'Cannot reach the download server. Is it running (node server.mjs in tmpBack)?'
          : (e as Error).message;
      this.showToast('error', `Download failed: ${message}`);
    } finally {
      this.downloading.set(false);
      this.job.set(null);
      this.finished.emit();
    }
  }

  /** Asks the server to stop. Finished tracks stay on disk; the unfinished one is cleaned up. */
  protected async stop(): Promise<void> {
    const id = this.job()?.id;
    if (!id || this.stopping()) return;
    this.stopping.set(true);
    try {
      await fetch(`${API}/jobs/${id}/cancel`, { method: 'POST' });
    } catch {
      this.stopping.set(false);
    }
  }

  /** Polls the job until it ends, feeding the progress bar. */
  private async follow(jobId: string): Promise<void> {
    for (;;) {
      const response = await fetch(`${API}/jobs/${jobId}`);
      const job: Job = await response.json();
      if (!response.ok) throw new Error('Lost track of the download job.');
      this.job.set(job);

      if (job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (job.status === 'error') throw new Error(job.error ?? 'Unknown error');

      this.summary.set(job);
      const label = job.name ? ` "${job.name}"` : '';
      const added = job.files.length;
      if (job.status === 'cancelled') {
        this.showToast('info', `Stopped${label}: ${added} of ${job.total} tracks added.`);
      } else {
        this.showToast('success', `Download complete${label}: ${added} new song(s) added.`);
      }
      return;
    }
  }

  protected dismissToast(): void {
    clearTimeout(this.toastTimer);
    this.toast.set(null);
  }

  private showToast(kind: Toast['kind'], text: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ kind, text });
    this.toastTimer = setTimeout(() => this.toast.set(null), 10000);
  }
}
