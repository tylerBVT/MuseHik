import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Track } from '../../../core/api';
import { LibraryService } from '../../../core/library.service';
import { NavService } from '../../../core/nav.service';
import { PlaylistService } from '../playlist.service';
import { PageHeader } from '../../../shared/page-header';

/** Create a playlist, or edit one (name + which songs, in the order they were ticked). */
@Component({
  imports: [PageHeader],
  selector: 'app-playlist-editor',
  styleUrl: './playlist-editor.css',
  templateUrl: './playlist-editor.html',
})
export class PlaylistEditor implements OnInit {
  protected readonly nav = inject(NavService);
  protected readonly library = inject(LibraryService);
  private readonly playlists = inject(PlaylistService);

  /** Set when editing; absent when creating. */
  readonly id = input<number>();
  protected readonly name = signal('');
  protected readonly query = signal('');
  /** Ticked song ids in the order they will play. */
  protected readonly selected = signal<number[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly visible = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.library.tracks().filter((t) => {
      const text = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
  protected readonly canSave = computed(() => this.name().trim().length > 0 && !this.saving());

  async ngOnInit(): Promise<void> {
    const id = this.id();
    if (id === undefined) return;
    const playlist = await this.playlists.get(id);
    if (!playlist) {
      this.error.set('This playlist does not exist any more.');
      return;
    }
    this.name.set(playlist.name);
    this.selected.set(playlist.tracks.map((t) => t.id));
  }

  protected isSelected(track: Track): boolean {
    return this.selected().includes(track.id);
  }

  protected toggle(track: Track): void {
    this.selected.update((ids) => (ids.includes(track.id) ? ids.filter((i) => i !== track.id) : [...ids, track.id]));
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const id = this.id();
      const saved =
        id === undefined
          ? await this.playlists.create(this.name(), this.selected())
          : await this.playlists.update(id, this.name(), this.selected());
      this.nav.go({ page: 'playlist', id: saved.id }, { replace: true });
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}
