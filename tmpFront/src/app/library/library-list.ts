import { Component, computed, inject, input, signal } from '@angular/core';
import { Track, coverUrl, formatTime } from '../core/api';
import { LibraryService } from '../core/library.service';
import { PlayerService } from '../core/player.service';

/** The song list with a simple text filter. Click a song to play it; next/previous follow this list. */
@Component({
  selector: 'app-library-list',
  templateUrl: './library-list.html',
  styleUrl: './library-list.css',
})
export class LibraryList {
  /** The songs to show (all tracks, or one playlist). Next/previous follow what is on screen. */
  readonly tracks = input.required<Track[]>();
  readonly heading = input('Tracks');
  readonly emptyMessage = input('No songs here yet.');

  protected readonly library = inject(LibraryService);
  protected readonly player = inject(PlayerService);

  protected readonly query = signal('');
  protected readonly formatTime = formatTime;
  protected readonly coverUrl = coverUrl;
  /** Ids whose cover failed to load (no embedded art), so a placeholder is shown instead. */
  protected readonly noCover = signal<ReadonlySet<number>>(new Set());

  protected readonly visible = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.tracks();
    return this.tracks().filter((track) => {
      const text = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected play(track: Track): void {
    // Re-clicking the song that is playing toggles pause instead of restarting it.
    if (this.player.current()?.id === track.id) this.player.toggle();
    else this.player.play(track, this.visible());
  }

  protected coverFailed(track: Track): void {
    this.noCover.update((set) => new Set(set).add(track.id));
  }
}
