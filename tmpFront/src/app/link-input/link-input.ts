import { Component, computed, signal } from '@angular/core';

type Toast = { kind: 'info' | 'success' | 'error'; text: string };

type Job = {
  status: 'running' | 'done' | 'error';
  name: string;
  total: number;
  done: number;
  current: string;
  files: string[];
  failed: { track: string; error: string }[];
  warning?: string;
  error?: string;
};

const API = 'http://127.0.0.1:3000/api';
const POLL_MS = 1500;

@Component({
  selector: 'app-link-input',
  templateUrl: './link-input.html',
  styleUrl: './link-input.css',
})
export class LinkInput {
  protected readonly link = signal('');
  protected readonly downloading = signal(false);
  protected readonly toast = signal<Toast | null>(null);
  protected readonly canDownload = computed(
    () => this.link().trim().length > 0 && !this.downloading(),
  );

  private toastTimer?: ReturnType<typeof setTimeout>;

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
  }

  protected async download(): Promise<void> {
    if (!this.canDownload()) return;
    this.downloading.set(true);
    this.showToast('info', 'Download started...', false);
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
    }
  }

  /** Polls the job until it finishes, updating the popup with progress. */
  private async follow(jobId: string): Promise<void> {
    for (;;) {
      const response = await fetch(`${API}/jobs/${jobId}`);
      const job: Job = await response.json();
      if (!response.ok) throw new Error('Lost track of the download job.');

      if (job.status === 'running') {
        const progress = job.total > 1 ? ` ${job.done}/${job.total}` : '';
        this.showToast('info', `Downloading${progress}: ${job.current || 'preparing...'}`, false);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (job.status === 'error') throw new Error(job.error ?? 'Unknown error');

      const failed = job.failed.length ? `, ${job.failed.length} failed` : '';
      const label = job.name ? ` "${job.name}"` : '';
      this.showToast('success', `Download complete${label}: ${job.files.length} file(s)${failed}.`);
      return;
    }
  }

  protected dismissToast(): void {
    clearTimeout(this.toastTimer);
    this.toast.set(null);
  }

  /** Info toasts stay until replaced; success/error close on their own after 8 s. */
  private showToast(kind: Toast['kind'], text: string, autoClose = true): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ kind, text });
    if (autoClose) this.toastTimer = setTimeout(() => this.toast.set(null), 8000);
  }
}
