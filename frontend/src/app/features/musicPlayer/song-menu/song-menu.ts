import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Track } from '../../../core/api';
import { LibraryService, SongChanges } from '../../../core/library.service';
import { CloudService, cloudOnline } from '../../cloud/cloud.service';

/**
 * The ⋮ menu of one song, as a dialog: rename (title, artist), genre, delete, and moving it between this laptop and
 * the cloud. Library songs are changed in their file; cloud songs in the shared list (and the cloud file's name).
 */
@Component({
  selector: 'app-song-menu',
  styles: `
    dialog {
      width: min(440px, calc(100vw - 32px));
      padding: 20px;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0;
      font-size: 1.1rem;
      overflow-wrap: anywhere;
    }
    .where {
      margin: 4px 0 16px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
      font-size: 0.9rem;
    }
    input {
      padding: 8px 10px;
      font: inherit;
      color: inherit;
      background: var(--surface);
      border: 1px solid var(--text-faint);
      border-radius: 8px;
    }
    input:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .buttons.more {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
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
    .action.danger {
      color: var(--danger);
      border-color: var(--danger);
    }
    .action.danger.armed {
      color: var(--on-accent);
      background: var(--danger);
    }
    .action:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .status {
      margin: 12px 0 0;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    .status.error {
      color: var(--danger);
    }
  `,
  template: `
    <dialog #dialog aria-labelledby="song-menu-title" (close)="closed.emit()">
      <form (submit)="save($event)">
        <h2 id="song-menu-title">{{ track().title }}</h2>
        <p class="where">{{ onCloud() ? 'On the cloud' : 'On this laptop' }}</p>
        <label>
          Title
          <input name="title" autocomplete="off" maxlength="200" [value]="title()" (input)="title.set(value($event))" />
        </label>
        <label>
          Artist
          <input name="artist" autocomplete="off" maxlength="200" [value]="artist()" (input)="artist.set(value($event))" />
        </label>
        <label>
          Genre
          <input
            name="genre"
            autocomplete="off"
            maxlength="60"
            list="song-menu-genres"
            placeholder="Rap, Jazz, Pop..."
            [value]="genre()"
            (input)="genre.set(value($event))"
          />
          <datalist id="song-menu-genres">
            @for (g of genres(); track g) {
              <option [value]="g"></option>
            }
          </datalist>
        </label>
        <div class="buttons">
          <button type="submit" class="action primary" [disabled]="busy() || !changes()">Save</button>
          <button type="button" class="action" (click)="close()">Close</button>
        </div>
        <div class="buttons more">
          @if (!onCloud() && cloudReady()) {
            <button type="button" class="action" [disabled]="busy()" (click)="sendToCloud()">Send to cloud</button>
          }
          @if (onCloud()) {
            <button type="button" class="action" [disabled]="busy()" (click)="saveToLaptop()">Save to this laptop</button>
          }
          <button
            type="button"
            class="action danger"
            [class.armed]="confirming()"
            [disabled]="busy()"
            (click)="remove()"
          >
            {{ deleteLabel() }}
          </button>
        </div>
        @if (status(); as s) {
          <p class="status" [class.error]="s.error" role="status">{{ s.text }}</p>
        }
      </form>
    </dialog>
  `,
})
export class SongMenu implements AfterViewInit, OnDestroy {
  /** The song (a cloud song has a negative id and a `stream` URL). */
  readonly track = input.required<Track>();
  /** Genres already used, offered while typing. */
  readonly genres = input<string[]>([]);
  readonly closed = output<void>();
  /** Something changed (renamed, deleted...): the page reloads what it shows. */
  readonly changed = output<void>();

  private readonly library = inject(LibraryService);
  private readonly cloud = inject(CloudService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly onCloud = computed(() => Boolean(this.track().stream));
  protected readonly cloudReady = computed(() => cloudOnline(this.cloud.settings()));
  /** What the fields showed when the menu opened: only fields changed from these are sent. */
  private readonly initial = computed(() => {
    const t = this.track();
    // A playlist row has no genre: take it from the library list when the song is there.
    const known = t.stream ? null : this.library.tracks().find((x) => x.id === t.id);
    return { title: t.title, artist: t.artist, genre: known?.genre ?? t.genre ?? '' };
  });
  protected readonly title = signal('');
  protected readonly artist = signal('');
  protected readonly genre = signal('');
  protected readonly busy = signal(false);
  protected readonly confirming = signal(false);
  protected readonly status = signal<{ text: string; error: boolean } | null>(null);

  protected readonly changes = computed<SongChanges | null>(() => {
    const start = this.initial();
    const next: SongChanges = {};
    if (this.title().trim() !== start.title) next.title = this.title().trim();
    if (this.artist().trim() !== start.artist) next.artist = this.artist().trim();
    if (this.genre().trim() !== start.genre) next.genre = this.genre().trim();
    return Object.keys(next).length ? next : null;
  });
  protected readonly deleteLabel = computed(() => {
    if (!this.confirming()) return this.onCloud() ? 'Delete from the cloud' : 'Delete';
    return this.onCloud() ? 'Click again: delete it from the cloud for good' : 'Click again: move it to the Recycle Bin';
  });

  private gone = false;

  ngOnDestroy(): void {
    this.gone = true;
  }

  ngAfterViewInit(): void {
    if (!this.cloud.settings()) this.cloud.getSettings().catch(() => {}); // for "Send to cloud"
    const start = this.initial();
    this.title.set(start.title);
    this.artist.set(start.artist);
    this.genre.set(start.genre);
    this.dialog().nativeElement.showModal();
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected close(): void {
    this.dialog().nativeElement.close(); // fires (close), which tells the list
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const changes = this.changes();
    if (!changes) return;
    await this.act(async () => {
      const id = this.track().id;
      if (this.onCloud()) await this.cloud.editSong(-id, changes);
      else await this.library.edit(id, changes);
      this.changed.emit();
      this.close();
    });
  }

  protected async remove(): Promise<void> {
    if (!this.confirming()) {
      this.confirming.set(true);
      return;
    }
    await this.act(async () => {
      const id = this.track().id;
      if (this.onCloud()) await this.cloud.deleteSong(-id);
      else await this.library.remove(id);
      this.changed.emit();
      this.close();
    });
  }

  protected async sendToCloud(): Promise<void> {
    await this.act(async () => {
      const result = await this.cloud.queueUpload([this.track().id]);
      this.status.set({
        text: result.queued ? 'It will go to the cloud after the upload running now.' : 'Sending it to the cloud...',
        error: false,
      });
    });
  }

  /** Copies this cloud song into the music folder (like the "Download from cloud" page), and says how it went. */
  protected async saveToLaptop(): Promise<void> {
    await this.act(async () => {
      const { jobId } = await this.cloud.startSave([-this.track().id]);
      this.status.set({ text: 'Saving it to this laptop...', error: false });
      for (let i = 0; i < 600 && !this.gone; i++) {
        const job = await this.cloud.getSave(jobId);
        if (job.state !== 'running') {
          if (job.saved.length) {
            this.status.set({ text: 'Saved: it is in your music folder and in All tracks.', error: false });
            void this.library.load();
            this.changed.emit();
          } else if (job.skipped.length) this.status.set({ text: 'It is already in your library.', error: false });
          else this.status.set({ text: job.failed[0]?.reason ?? job.error ?? 'Could not save it.', error: true });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
  }

  private async act(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.status.set(null);
    try {
      await work();
    } catch (e) {
      this.status.set({ text: (e as Error).message, error: true });
      this.confirming.set(false);
    } finally {
      this.busy.set(false);
    }
  }
}
