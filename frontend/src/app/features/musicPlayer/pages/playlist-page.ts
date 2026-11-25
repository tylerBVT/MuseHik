import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { NavService } from '../../../core/nav.service';
import { isPhone } from '../../../core/platform';
import { CloudService, cloudOnline } from '../../cloud/cloud.service';
import { Playlist, PlaylistService, toTracks } from '../playlist.service';
import { LibraryList } from '../library-list/library-list';
import { PageHeader } from '../../../shared/page-header';

/** One playlist: its songs (click to play), Edit, Delete, and the Shared switch. */
@Component({
  imports: [PageHeader, LibraryList],
  selector: 'app-playlist-page',
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
      color: var(--danger);
    }
    .action:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .share {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .switch {
      position: relative;
      width: 34px;
      height: 20px;
      border-radius: 10px;
      background: var(--border-strong);
      transition: background 0.2s;
    }
    .switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--surface);
      transition: transform 0.2s;
    }
    .share[aria-checked='true'] .switch {
      background: var(--accent);
    }
    .share[aria-checked='true'] .switch::after {
      transform: translateX(14px);
    }
    .status {
      margin: 0 0 12px;
      color: var(--text-muted);
    }
    .status.error {
      color: var(--danger);
    }
    .notice {
      color: var(--text-muted);
    }
  `,
  template: `
    <app-page-header [title]="playlist()?.name ?? 'Playlist'">
      @if (playlist(); as current) {
        <!-- On the phone every playlist is on the cloud: there is nothing to switch. -->
        @if (!isPhone) {
        <button
          type="button"
          class="action share"
          role="switch"
          [attr.aria-checked]="current.shared"
          [disabled]="busy() || (!current.shared && !canShare())"
          [title]="canShare() ? '' : 'Sharing needs the cloud: set it up and turn it on in Settings.'"
          (click)="toggleShared()"
        >
          <span class="switch" aria-hidden="true"></span> Shared
        </button>
        }
        <button type="button" class="action" (click)="nav.go({ page: 'edit', id: id() })">Edit</button>
        <button type="button" class="action danger" (click)="remove()">Delete</button>
      }
    </app-page-header>
    @if (playlist(); as current) {
      @if (message(); as m) {
        <p class="status" [class.error]="m.error" role="status">{{ m.text }}</p>
      } @else if (current.shared) {
        <p class="status">
          @if (fromOther()) {
            Shared by {{ current.owner }}.
          } @else if (isPhone) {
            On the cloud: it shows on the laptops too.
          } @else {
            Shared: it is on the cloud and shows on the other laptop.
          }
        </p>
      }
      <app-library-list
        heading="Songs"
        [tracks]="tracks()"
        (changed)="reload()"
        emptyMessage="This playlist is empty. Press Edit to add songs."
      />
    } @else if (missing()) {
      <p class="notice">This playlist does not exist any more.</p>
    }
  `,
})
export class PlaylistPage implements OnInit {
  protected readonly nav = inject(NavService);
  private readonly playlists = inject(PlaylistService);
  private readonly cloud = inject(CloudService);

  readonly id = input.required<number>();
  protected readonly playlist = signal<Playlist | null>(null);
  protected readonly missing = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  private readonly myName = signal<string | null>(null);
  /** Sharing needs the cloud set up and Online on this laptop (unsharing always works). */
  protected readonly isPhone = isPhone;
  protected readonly canShare = computed(() => cloudOnline(this.cloud.settings()));

  protected readonly tracks = computed(() => toTracks(this.playlist()?.songs ?? []));
  protected readonly fromOther = computed(() => {
    const p = this.playlist();
    return Boolean(p?.shared && p.owner && this.myName() !== null && p.owner !== this.myName());
  });

  async ngOnInit(): Promise<void> {
    const found = await this.playlists.get(this.id());
    this.playlist.set(found);
    this.missing.set(!found);
    this.cloud
      .getSettings()
      .then((s) => this.myName.set(s.displayName))
      .catch(() => {});
  }

  /** After a change from a song's ⋮ menu (a renamed song keeps its place; a deleted one shows as not available). */
  protected async reload(): Promise<void> {
    this.playlist.set(await this.playlists.get(this.id()));
  }

  protected async toggleShared(): Promise<void> {
    const current = this.playlist();
    if (!current) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const updated = await this.playlists.setShared(current.id, !current.shared);
      this.playlist.set(updated);
      this.message.set({
        text: updated.shared
          ? 'Shared. It shows on the other laptop; songs the cloud does not have yet are uploading in the background.'
          : 'No longer shared. It stays here, and disappears from the other laptop at its next sync.',
        error: false,
      });
    } catch (e) {
      this.message.set({ text: (e as Error).message, error: true });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const current = this.playlist();
    const note = isPhone
      ? ' It is on the cloud, so it also disappears from the laptops.'
      : current?.shared ? ' It is shared, so it also disappears from the other laptop.' : '';
    const songs = isPhone ? 'Your songs stay on the cloud.' : 'Your songs stay in the library.';
    if (!current || !confirm(`Delete the playlist "${current.name}"? ${songs}${note}`)) return;
    await this.playlists.remove(current.id);
    this.nav.go({ page: 'home' }, { replace: true });
  }
}
