import { Component, OnInit, inject, input, signal } from '@angular/core';
import { NavService } from '../core/nav.service';
import { Playlist, PlaylistService } from '../core/playlist.service';
import { LibraryList } from '../library/library-list';
import { PageHeader } from '../shared/page-header';

/** One playlist: its songs (click to play) plus Edit and Delete. */
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
    .notice {
      color: var(--text-muted);
    }
  `,
  template: `
    <app-page-header [title]="playlist()?.name ?? 'Playlist'">
      @if (playlist()) {
        <button type="button" class="action" (click)="nav.go({ page: 'edit', id: id() })">Edit</button>
        <button type="button" class="action danger" (click)="remove()">Delete</button>
      }
    </app-page-header>
    @if (playlist(); as current) {
      <app-library-list
        heading="Songs"
        [tracks]="current.tracks"
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

  readonly id = input.required<number>();
  protected readonly playlist = signal<Playlist | null>(null);
  protected readonly missing = signal(false);

  async ngOnInit(): Promise<void> {
    const found = await this.playlists.get(this.id());
    this.playlist.set(found);
    this.missing.set(!found);
  }

  protected async remove(): Promise<void> {
    const current = this.playlist();
    if (!current || !confirm(`Delete the playlist "${current.name}"? Your songs stay in the library.`)) return;
    await this.playlists.remove(current.id);
    this.nav.go({ page: 'home' }, { replace: true });
  }
}
