import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Track, coverUrl, formatTime } from '../../../core/api';
import { LibraryService } from '../../../core/library.service';
import { deviceName } from '../../../core/platform';
import { PlayerService } from '../player.service';
import { SongMenu } from '../song-menu/song-menu';
import { PERIODS, SORTS, Since, SortBy, arrange, formatDay, genresOf } from './arrange';

/** The song list with a text filter (plus sort and period menus when `sortable`). Click a song to play it; next/previous follow this list. */
@Component({
  imports: [SongMenu],
  selector: 'app-library-list',
  templateUrl: './library-list.html',
  styleUrl: './library-list.css',
})
export class LibraryList {
  /** The songs to show (all tracks, or one playlist). Next/previous follow what is on screen. */
  readonly tracks = input.required<Track[]>();
  readonly heading = input('Tracks');
  readonly emptyMessage = input('No songs here yet.');
  /** Ids of songs that play without the network (cloud page): marked "on this laptop". */
  readonly onLaptop = input<ReadonlySet<number> | null>(null);
  /** Shows the sort and period menus (not on playlists, whose order is the playlist's). */
  readonly sortable = input(false);
  /** A song was renamed, deleted... from its ⋮ menu: the page reloads its songs. */
  readonly changed = output<void>();

  protected readonly library = inject(LibraryService);
  protected readonly player = inject(PlayerService);

  protected readonly query = signal('');
  protected readonly sort = signal<SortBy>('default');
  protected readonly since = signal<Since>('any');
  /** '' = any genre. */
  protected readonly genre = signal('');
  protected readonly genres = computed(() => genresOf(this.tracks()));
  /** The song whose ⋮ menu is open. */
  protected readonly menuFor = signal<Track | null>(null);
  protected readonly sorts = SORTS;
  protected readonly periods = PERIODS;
  protected readonly formatTime = formatTime;
  protected readonly formatDay = formatDay;
  protected readonly coverUrl = coverUrl;
  protected readonly device = deviceName;
  /** Ids whose cover failed to load (no embedded art), so a placeholder is shown instead. */
  protected readonly noCover = signal<ReadonlySet<number>>(new Set());

  protected readonly visible = computed(() =>
    arrange(this.tracks(), {
      query: this.query(),
      sort: this.sortable() ? this.sort() : 'default',
      since: this.sortable() ? this.since() : 'any',
      genre: this.sortable() ? this.genre() : '',
    }),
  );

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
  protected onSort(event: Event): void {
    this.sort.set((event.target as HTMLSelectElement).value as SortBy);
  }
  protected onSince(event: Event): void {
    this.since.set((event.target as HTMLSelectElement).value as Since);
  }
  protected onGenre(event: Event): void {
    this.genre.set((event.target as HTMLSelectElement).value);
  }

  protected play(track: Track): void {
    if (track.unavailable) return;
    // Re-clicking the song that is playing toggles pause instead of restarting it.
    if (this.player.current()?.id === track.id) this.player.toggle();
    else this.player.play(track, this.visible().filter((t) => !t.unavailable));
  }

  protected coverFailed(track: Track): void {
    this.noCover.update((set) => new Set(set).add(track.id));
  }
}
