import { Injectable, signal } from '@angular/core';
import { API, Track } from '../../core/api';

export type SeparationMethod = { id: string; name: string; summary: string; description: string };
/** A finished instrumental. `file` is its name in the music folder (it is also a song in the library). */
export type SeparationResult = { method: string; size: number; createdAt: string; file: string };
export type SeparationJob = {
  id: string;
  trackId: number;
  method: string;
  title: string;
  artist: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  error: string | null;
  seconds: number | null;
};

const ACTIVE = new Set(['queued', 'running']);

/**
 * Talks to the server's separator API. Root-level, so a running separation keeps being followed (and its result
 * picked up) when you leave the page and come back.
 */
@Injectable({ providedIn: 'root' })
export class SeparatorService {
  readonly methods = signal<SeparationMethod[]>([]);
  /** False when the server says the Python separator is not installed. */
  readonly available = signal(true);
  /** Jobs seen in this session, by id (latest state). */
  readonly jobs = signal<Record<string, SeparationJob>>({});
  /** Bumped when a job finishes, so pages reload the results of that song. */
  readonly finished = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  async loadMethods(): Promise<void> {
    if (this.methods().length) return;
    const data = await this.get<{ available: boolean; methods: SeparationMethod[] }>('/separator/methods');
    this.methods.set(data.methods);
    this.available.set(data.available);
  }

  async results(trackId: number): Promise<{ results: SeparationResult[]; job: SeparationJob | null }> {
    const data = await this.get<{ results: SeparationResult[]; job: SeparationJob | null }>(`/separator/tracks/${trackId}`);
    if (data.job) this.track(data.job);
    return data;
  }

  async start(trackId: number, method: string): Promise<SeparationJob> {
    const job = await this.send<SeparationJob>('POST', '/separator/jobs', { trackId, method });
    this.track(job);
    return job;
  }

  async cancel(job: SeparationJob): Promise<void> {
    this.track(await this.send<SeparationJob>('POST', `/separator/jobs/${job.id}/cancel`));
  }

  async remove(trackId: number, method: string): Promise<void> {
    await this.send('DELETE', `/separator/tracks/${trackId}/${method}`);
  }

  audioUrl(track: Track, method: string, version = ''): string {
    return `${API}/separator/tracks/${track.id}/${method}/audio${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  }

  /** The active (queued/running) job of a song, if any. */
  activeFor(trackId: number): SeparationJob | null {
    return Object.values(this.jobs()).find((j) => j.trackId === trackId && ACTIVE.has(j.status)) ?? null;
  }

  /** The most recent job of a song + method (to show a failure message). */
  lastFor(trackId: number, method: string): SeparationJob | null {
    const all = Object.values(this.jobs()).filter((j) => j.trackId === trackId && j.method === method);
    return all.length ? all[all.length - 1] : null;
  }

  private track(job: SeparationJob): void {
    const before = this.jobs()[job.id];
    this.jobs.update((all) => ({ ...all, [job.id]: job }));
    if (before && ACTIVE.has(before.status) && !ACTIVE.has(job.status)) this.finished.update((n) => n + 1);
    if (ACTIVE.has(job.status)) this.poll();
  }

  /** While any job is active, ask the server for its state every second. */
  private poll(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      const active = Object.values(this.jobs()).filter((j) => ACTIVE.has(j.status));
      if (!active.length) {
        clearInterval(this.timer!);
        this.timer = null;
        return;
      }
      for (const job of active) {
        try {
          this.track(await this.get<SeparationJob>(`/separator/jobs/${job.id}`));
        } catch {
          // server restarted: the job is gone
          this.track({ ...job, status: 'failed', stage: 'Failed', error: 'The server restarted during the separation.' });
        }
      }
    }, 1000);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `Server error ${response.status}`);
    return data as T;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `Server error ${response.status}`);
    return data as T;
  }
}
