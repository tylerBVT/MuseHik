import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { LibraryService } from '../../core/library.service';
import { NavService } from '../../core/nav.service';
import { deviceName, isPhone } from '../../core/platform';
import { PageHeader } from '../../shared/page-header';
import { CloudService, CloudSong, SaveJob, formatSize } from './cloud.service';

const POLL_MS = 700;

/** "Download from cloud": tick cloud songs, they are copied into this laptop's music folder (and library); on the phone, saved on the phone (they play without the network). */
@Component({
  imports: [PageHeader],
  selector: 'app-cloud-save-page',
  styles: `
    .help,
    .notice {
      color: var(--text-muted);
    }
    .error {
      color: var(--danger);
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
    }
    .search {
      flex: 1 1 220px;
      max-width: 340px;
      padding: 9px 12px;
      font: inherit;
      color: inherit;
      background: var(--surface);
      border: 1px solid var(--text-faint);
      border-radius: 8px;
    }
    .action {
      padding: 8px 14px;
      color: var(--text-strong);
      font: inherit;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      cursor: pointer;
    }
    .action:hover {
      background: var(--hover);
    }
    .action.primary {
      color: var(--on-accent);
      background: var(--accent);
      border-color: var(--accent);
    }
    .action:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .songs {
      margin: 0 0 80px;
      padding: 0;
      list-style: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .songs li + li {
      border-top: 1px solid var(--hover);
    }
    .song {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      cursor: pointer;
    }
    .song.on {
      background: var(--accent-bg);
    }
    .song input {
      width: 18px;
      height: 18px;
    }
    .meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .meta span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .artist,
    .size {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .size {
      margin-left: auto;
      white-space: nowrap;
    }
    .badge {
      margin-left: 6px;
      padding: 1px 6px;
      font-size: 0.75rem;
      color: var(--accent);
      border: 1px solid var(--accent);
      border-radius: 999px;
    }
    .send {
      position: sticky;
      bottom: 90px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 12px;
    }
    .progress {
      margin-bottom: 16px;
      padding: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .progress p {
      margin: 6px 0 0;
    }
    .bar {
      height: 10px;
      margin: 8px 0;
      border-radius: 5px;
      background: var(--border);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s ease;
    }
    .reasons {
      margin: 6px 0 0;
      padding-left: 18px;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
  `,
  template: `
    <app-page-header title="Download from cloud" />
    @if (isPhone) {
      <p class="help">
        Tick cloud songs to save them on this phone. They then play without the internet and show in All tracks.
        Songs already on this phone are not listed.
      </p>
    } @else {
      <p class="help">
        Tick cloud songs to copy them into your music folder. They then play without the internet, like any downloaded
        song. Songs already in your library are not listed.
      </p>
    }
    @if (switchedOff()) {
      <p class="notice">
        @if (isPhone) {
          The cloud is off on this phone: songs cannot be saved until it is on again (Settings).
        } @else {
          The cloud is offline on this laptop: only songs already played here (kept in the cache) can be saved.
        }
      </p>
    } @else if (offline()) {
      <p class="notice">
        The cloud cannot be reached right now{{ isPhone ? ': try again with a connection.' : ': only songs already played here can be saved.' }}
      </p>
    }
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    @if (job(); as j) {
      <section class="progress" aria-live="polite">
        <strong>
          @switch (j.state) {
            @case ('running') { Saving to this {{ device }}... }
            @case ('done') { Saved to this {{ device }} }
            @case ('stopped') { Stopped }
            @case ('failed') { Could not save }
          }
        </strong>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent()">
          <div class="fill" [style.width.%]="percent()"></div>
        </div>
        <p>
          {{ j.done }} / {{ j.total }}
          @if (j.current) {
            · {{ j.current }}
          }
        </p>
        @if (j.state === 'running') {
          <button type="button" class="action" (click)="stop()">Stop</button>
        } @else {
          <p>
            {{ j.saved.length }} saved
            @if (j.skipped.length) {
              · {{ j.skipped.length }} already in your library
            }
            @if (j.failed.length) {
              · {{ j.failed.length }} failed
            }
          </p>
          @if (j.error) {
            <p class="error">{{ j.error }}</p>
          }
          @if (j.failed.length) {
            <ul class="reasons">
              @for (f of j.failed; track f.id) {
                <li>{{ f.artist ? f.artist + ' - ' : '' }}{{ f.title }}: {{ f.reason }}</li>
              }
            </ul>
          }
        }
      </section>
    }

    @if (!loaded()) {
      <p class="notice">Loading the cloud...</p>
    } @else if (!candidates().length) {
      <p class="notice">Every cloud song is already in your library.</p>
    } @else {
      <div class="tools">
        <input
          type="search"
          class="search"
          placeholder="Search title or artist"
          aria-label="Search the cloud songs"
          autocomplete="off"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
        <button type="button" class="action" (click)="pickAll()">
          {{ allShownPicked() ? 'Unselect shown' : 'Select shown' }}
        </button>
      </div>
      <ul class="songs">
        @for (song of shown(); track song.id) {
          <li>
            <label class="song" [class.on]="picked().has(song.id)">
              <input type="checkbox" [checked]="picked().has(song.id)" (change)="toggle(song)" />
              <span class="meta">
                <span>{{ song.title }}</span>
                <span class="artist">
                  {{ song.artist || 'Unknown artist' }}
                  @if (song.onLaptop) {
                    <span class="badge">played here: no download</span>
                  }
                </span>
              </span>
              <span class="size">{{ size(song.size) }}</span>
            </label>
          </li>
        } @empty {
          <li class="song notice">No cloud song matches "{{ query() }}".</li>
        }
      </ul>
      <footer class="send">
        <strong>{{ picked().size }} {{ picked().size === 1 ? 'song' : 'songs' }}, {{ size(pickedBytes()) }}</strong>
        <button type="button" class="action primary" [disabled]="!picked().size || running()" (click)="save()">
          Save {{ picked().size || '' }} to this {{ device }}
        </button>
      </footer>
    }
  `,
})
export class CloudSavePage implements OnInit, OnDestroy {
  protected readonly nav = inject(NavService);
  private readonly cloud = inject(CloudService);
  private readonly library = inject(LibraryService);

  protected readonly songs = signal<CloudSong[]>([]);
  protected readonly loaded = signal(false);
  protected readonly offline = signal(false);
  protected readonly switchedOff = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly job = signal<SaveJob | null>(null);
  protected readonly size = formatSize;
  protected readonly device = deviceName;
  protected readonly isPhone = isPhone;
  private polling?: ReturnType<typeof setTimeout>;

  /** Cloud songs this laptop's library does not have. */
  protected readonly candidates = computed(() => this.songs().filter((s) => !s.inLibrary));
  protected readonly shown = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.candidates().filter((s) => {
      const text = `${s.title} ${s.artist}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  protected readonly allShownPicked = computed(() => {
    const shown = this.shown();
    return shown.length > 0 && shown.every((s) => this.picked().has(s.id));
  });
  protected readonly pickedBytes = computed(() =>
    this.candidates().reduce((sum, s) => sum + (this.picked().has(s.id) ? s.size : 0), 0),
  );
  protected readonly running = computed(() => this.job()?.state === 'running');
  protected readonly percent = computed(() => {
    const j = this.job();
    return j && j.total ? Math.round((j.done / j.total) * 100) : 0;
  });

  async ngOnInit(): Promise<void> {
    await this.load();
    const active = await this.cloud.activeSave().catch(() => null);
    if (active) this.follow(active);
  }

  ngOnDestroy(): void {
    if (this.polling) clearTimeout(this.polling);
  }

  private async load(): Promise<void> {
    try {
      const result = await this.cloud.songs();
      this.songs.set(result.songs);
      this.offline.set(result.offline);
      this.switchedOff.set(result.mode === 'offline');
      this.error.set(null);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loaded.set(true);
    }
  }

  protected toggle(song: CloudSong): void {
    this.picked.update((set) => {
      const next = new Set(set);
      if (!next.delete(song.id)) next.add(song.id);
      return next;
    });
  }

  protected pickAll(): void {
    const shown = this.shown();
    const unpick = this.allShownPicked();
    this.picked.update((set) => {
      const next = new Set(set);
      for (const s of shown) {
        if (unpick) next.delete(s.id);
        else next.add(s.id);
      }
      return next;
    });
  }

  protected async save(): Promise<void> {
    const ids = [...this.picked()];
    if (!ids.length) return;
    this.error.set(null);
    try {
      const { jobId } = await this.cloud.startSave(ids);
      this.picked.set(new Set());
      this.follow(await this.cloud.getSave(jobId));
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  protected async stop(): Promise<void> {
    const j = this.job();
    if (j) this.job.set(await this.cloud.cancelSave(j.id).catch(() => j));
  }

  /** Shows the job's progress until it ends, then refreshes the lists. */
  private follow(job: SaveJob): void {
    this.job.set(job);
    if (job.state !== 'running') {
      void this.load();
      void this.library.load();
      return;
    }
    this.polling = setTimeout(async () => {
      try {
        this.follow(await this.cloud.getSave(job.id));
      } catch (e) {
        this.error.set((e as Error).message);
      }
    }, POLL_MS);
  }
}
