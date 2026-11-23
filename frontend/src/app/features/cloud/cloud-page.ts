import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NavService } from '../../core/nav.service';
import { PageHeader } from '../../shared/page-header';
import { LibraryList } from '../musicPlayer/library-list/library-list';
import { CloudService, CloudSong, formatSize } from './cloud.service';
import { CloudUsage } from './usage-bar';

/** Every song on the cloud, played like a playlist. "Remove songs" deletes some from the cloud. */
@Component({
  imports: [PageHeader, LibraryList, CloudUsage],
  selector: 'app-cloud-page',
  styles: `
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
    .action.danger {
      color: var(--on-accent);
      background: var(--danger);
      border-color: var(--danger);
    }
    .action:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .notice {
      color: var(--text-muted);
    }
    .error {
      color: var(--danger);
    }
    .remove-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .songs {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .song {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .song.on {
      background: var(--accent-bg);
    }
    .meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
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
  `,
  template: `
    <app-page-header title="Cloud">
      <button type="button" class="action" (click)="nav.go({ page: 'cloud-upload' })">Upload</button>
      @if (songs().length) {
        <button type="button" class="action" (click)="toggleRemoving()">{{ removing() ? 'Done' : 'Remove songs' }}</button>
      }
    </app-page-header>
    <app-cloud-usage />

    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (offline()) {
      <p class="notice">The cloud cannot be reached right now. Showing the last known list: songs on this laptop still play.</p>
    }

    @if (removing()) {
      <div class="remove-bar">
        <span>{{ picked().size }} selected</span>
        <button type="button" class="action danger" [disabled]="!picked().size || busy()" (click)="removePicked()">
          {{ confirming() ? 'Click again to delete from the cloud' : 'Delete ' + picked().size + ' from the cloud' }}
        </button>
      </div>
      <ul class="songs">
        @for (song of songs(); track song.id) {
          <li>
            <label class="song" [class.on]="picked().has(song.id)">
              <input type="checkbox" [checked]="picked().has(song.id)" (change)="togglePick(song)" />
              <span class="meta">
                <span>{{ song.title }}</span>
                <span class="artist">{{ song.artist || 'Unknown artist' }}</span>
              </span>
              <span class="size">{{ size(song.size) }}</span>
            </label>
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <app-library-list
        heading="Cloud songs"
        [tracks]="tracks()"
        [onLaptop]="onLaptop()"
        [sortable]="true"
        emptyMessage="Nothing on the cloud yet. Press Upload to send songs."
      />
    } @else {
      <p class="notice">Loading the cloud...</p>
    }
  `,
})
export class CloudPage implements OnInit {
  protected readonly nav = inject(NavService);
  private readonly cloud = inject(CloudService);

  protected readonly songs = signal<CloudSong[]>([]);
  protected readonly loaded = signal(false);
  protected readonly offline = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly removing = signal(false);
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly size = formatSize;

  protected readonly tracks = computed(() => this.songs().map((s) => this.cloud.toTrack(s)));
  protected readonly onLaptop = computed(() => new Set(this.songs().filter((s) => s.onLaptop).map((s) => -s.id)));

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const result = await this.cloud.songs();
      this.songs.set(result.songs);
      this.offline.set(result.offline);
      this.error.set(null);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loaded.set(true);
    }
  }

  protected toggleRemoving(): void {
    this.removing.update((on) => !on);
    this.picked.set(new Set());
    this.confirming.set(false);
  }

  protected togglePick(song: CloudSong): void {
    this.confirming.set(false);
    this.picked.update((set) => {
      const next = new Set(set);
      if (!next.delete(song.id)) next.add(song.id);
      return next;
    });
  }

  /** Two clicks: the first arms the button, the second deletes. */
  protected async removePicked(): Promise<void> {
    if (!this.confirming()) {
      this.confirming.set(true);
      return;
    }
    this.busy.set(true);
    try {
      for (const id of this.picked()) await this.cloud.deleteSong(id);
      this.removing.set(false);
      this.picked.set(new Set());
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
      this.confirming.set(false);
      await this.load();
      void this.cloud.loadStatus();
    }
  }
}
