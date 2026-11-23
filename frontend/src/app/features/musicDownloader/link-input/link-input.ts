import { Component, computed, inject, output, signal } from '@angular/core';
import { API } from '../../../core/api';
import { NavService } from '../../../core/nav.service';
import { CloudService } from '../../cloud/cloud.service';

type Toast = { kind: 'info' | 'success' | 'error'; text: string };

/** A plain-language error: what went wrong, what to try, and the raw tool output. */
type Problem = { kind?: string; error: string; hint?: string; detail?: string };

type Upload = { url: string; title: string; channel: string; duration: number };

/** One song that could not be downloaded, with what was tried (see backend report.mjs). */
type Failure = { track: string } & Problem & {
  stage?: string;
  candidates?: Upload[];
  attempts?: { url: string; kind: string; error: string }[];
};

export type Job = {
  id: string;
  url?: string;
  platform?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  name: string;
  total: number;
  done: number;
  skipped: number;
  current: string;
  files: string[];
  skippedList: { track: string; reason: string }[];
  failed: Failure[];
  /** Full report saved by the server (a .txt in backend/data/download-reports). */
  reportFile?: string;
  /** Tracks not attempted because YouTube started blocking (a later "Try again" picks them up). */
  notTried?: string[];
  /** Things worth knowing that are not errors (another upload was used, yt-dlp was updated...). */
  notes?: string[];
  /** Set while the job waits for YouTube to stop blocking (it resumes by itself). */
  pausedUntil?: string | null;
  pauses?: number;
  pausedMinutes?: number;
  warning?: string;
  error?: string;
  hint?: string;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  /** "Also send to the cloud" was ticked. */
  toCloud?: boolean;
  /** Set when the download ended with "Also send to the cloud": how many songs went to the upload. */
  cloud?: { songs: number; jobId?: string; queued?: boolean; error?: string };
};

const TO_CLOUD_KEY = 'musehik.download.toCloud';

const POLL_MS = 1000;
const STATUS_LABEL: Record<Job['status'], string> = {
  running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Stopped',
};

/** Badge for a history entry: "Incomplete" when it finished but stopped early (YouTube blocking). */
export const badgeOf = (job: Job): { label: string; tone: string } =>
  job.status === 'done' && job.error
    ? { label: 'Incomplete', tone: 'cancelled' }
    : { label: STATUS_LABEL[job.status], tone: job.status };

function readToCloud(): boolean {
  try {
    return localStorage.getItem(TO_CLOUD_KEY) === '1';
  } catch {
    return false;
  }
}

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
  /** Every past download, newest first, stored by the server (survives restarts). */
  protected readonly history = signal<Job[]>([]);
  /** The history entry shown expanded (the one that just finished). */
  protected readonly openId = signal<string | null>(null);
  /** Emitted when a download ends, so the library list can refresh. */
  readonly finished = output<void>();

  protected readonly badge = badgeOf;
  protected readonly nav = inject(NavService);
  private readonly cloud = inject(CloudService);
  /** The cloud is set up in Settings: the "Also send to the cloud" box is shown. */
  protected readonly cloudReady = signal(false);
  protected readonly toCloud = signal(readToCloud());

  constructor() {
    void this.loadHistory();
    void this.resumeRunning();
    void this.checkCloud();
  }

  private async checkCloud(): Promise<void> {
    try {
      const s = await this.cloud.getSettings();
      this.cloudReady.set(Boolean(s.host && s.user && s.hasPassword));
    } catch {
      this.cloudReady.set(false);
    }
  }

  protected setToCloud(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.toCloud.set(on);
    try {
      localStorage.setItem(TO_CLOUD_KEY, on ? '1' : '0');
    } catch {
      /* remembering the choice is a nicety */
    }
  }

  protected readonly canDownload = computed(
    () => this.link().trim().length > 0 && !this.downloading(),
  );
  /** 0-100, or null while the playlist length is still unknown (shows a moving "busy" bar). */
  protected readonly percent = computed(() => {
    const job = this.job();
    return job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  });

  /** "about 2 h 10 min left", from the pace so far (pauses excluded). Empty until there is a pace to go by. */
  protected readonly timeLeft = computed(() => {
    const job = this.job();
    if (!job?.startedAt || job.total < 5 || job.done < 3 || job.done >= job.total || job.pausedUntil) return '';
    const working = Date.now() - Date.parse(job.startedAt) - (job.pausedMinutes ?? 0) * 60000;
    const minutes = Math.max(1, Math.round((working / job.done) * (job.total - job.done) / 60000));
    return minutes < 60 ? `about ${minutes} min left` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
  });

  protected clock(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private toastTimer?: ReturnType<typeof setTimeout>;

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
  }

  protected async download(): Promise<void> {
    if (!this.canDownload()) return;
    const url = this.link().trim();
    await this.run(async () => {
      const start = await fetch(`${API}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, toCloud: this.cloudReady() && this.toCloud() }),
      });
      const started = await start.json();
      if (!start.ok) throw new Error(started.error ?? `Server error ${start.status}`);
      return started.jobId;
    });
  }

  /**
   * A download keeps running on the server when this page is closed or reloaded (long playlists take hours):
   * when the page opens, it picks up the progress of a running one.
   */
  private async resumeRunning(): Promise<void> {
    try {
      const response = await fetch(`${API}/download/active`);
      const active: Job | null = response.ok ? await response.json() : null;
      if (active && !this.downloading()) {
        if (active.url) this.link.set(active.url);
        await this.run(async () => active.id);
      }
    } catch {
      // Server not running.
    }
  }

  /** Shows the progress of a job (started by `start`) until it ends, then refreshes the history. */
  private async run(start: () => Promise<string>): Promise<void> {
    this.downloading.set(true);
    this.stopping.set(false);
    this.dismissToast();
    this.job.set({
      id: '', status: 'running', name: '', total: 0, done: 0, skipped: 0,
      current: 'Starting...', files: [], skippedList: [], failed: [],
    });
    try {
      await this.follow(await start());
    } catch (e) {
      const message =
        e instanceof TypeError
          ? 'Cannot reach the download server. Is it running (node server.mjs in backend)?'
          : (e as Error).message;
      this.showToast('error', `Download failed: ${message}`);
    } finally {
      this.downloading.set(false);
      this.job.set(null);
      this.finished.emit();
      await this.loadHistory();
    }
  }

  /** Puts a past link back in the box and downloads it again. */
  protected retry(entry: Job): void {
    if (!entry.url || this.downloading()) return;
    this.link.set(entry.url);
    void this.download();
  }

  protected async loadHistory(): Promise<void> {
    try {
      const response = await fetch(`${API}/download/history`);
      if (response.ok) this.history.set(await response.json());
    } catch {
      // Server not running: the download box already says so when used.
    }
  }

  /** Removes one entry, or the whole history when no entry is given. */
  protected async forget(entry?: Job): Promise<void> {
    if (!entry && !confirm('Clear the whole download history? (Downloaded songs are kept.)')) return;
    try {
      await fetch(`${API}/download/history${entry ? `/${entry.id}` : ''}`, { method: 'DELETE' });
    } finally {
      await this.loadHistory();
    }
  }

  protected toggle(entry: Job, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (open) this.openId.set(entry.id);
    else if (this.openId() === entry.id) this.openId.set(null);
  }

  /** Failures grouped by reason, biggest group first (a 2000-song playlist can fail for a few different reasons). */
  protected failureGroups(job: Job): { reason: string; hint: string; items: Failure[] }[] {
    const groups = new Map<string, { reason: string; hint: string; items: Failure[] }>();
    for (const f of job.failed) {
      const group = groups.get(f.error) ?? { reason: f.error, hint: f.hint ?? '', items: [] };
      group.items.push(f);
      groups.set(f.error, group);
    }
    return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  }

  protected attemptOf(failure: Failure, upload: Upload): string {
    return failure.attempts?.find((a) => a.url === upload.url)?.error ?? '';
  }

  /** Which entry's report was just copied (shows "Copied" for a moment). */
  protected readonly copied = signal<string | null>(null);

  /** Copies the plain-text report (what failed and why) to paste it to whoever improves the downloader. */
  protected async copyReport(entry: Job): Promise<void> {
    try {
      const response = await fetch(`${API}/download/history/${entry.id}/report`);
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      const text = await response.text();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Older browsers / no permission: the classic way.
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      this.copied.set(entry.id);
      setTimeout(() => this.copied() === entry.id && this.copied.set(null), 2500);
    } catch (e) {
      this.showToast('error', `Could not copy the report: ${(e as Error).message}`);
    }
  }

  protected fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  protected when(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
      this.openId.set(job.id); // the history below shows the full result, expanded
      if (job.status === 'error') throw new Error(job.error ?? 'Unknown error');

      const label = job.name ? ` "${job.name}"` : '';
      const added = job.files.length;
      if (job.status === 'cancelled') {
        this.showToast('info', `Stopped${label}: ${added} of ${job.total} tracks added.`);
      } else if (job.error) {
        this.showToast('error', `Stopped early${label}: ${added} new song(s) added. ${job.error}`);
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
    // Errors stay until closed; the details also stay in the history below.
    if (kind !== 'error') this.toastTimer = setTimeout(() => this.toast.set(null), 10000);
  }
}
