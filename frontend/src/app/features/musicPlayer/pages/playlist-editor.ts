import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { NavService } from '../../../core/nav.service';
import { CloudService, CloudSong } from '../../cloud/cloud.service';
import { PlaylistService, PlaylistSong, SongRef } from '../playlist.service';
import { PageHeader } from '../../../shared/page-header';

/** A row of the editor: a library song, a cloud song not on this laptop, or a kept song available nowhere. */
type Row = { key: string; title: string; artist: string; album: string; tag: '' | 'cloud' | 'not available'; ref: SongRef };

/**
 * Create a playlist, or edit one (name + which songs, in the order they were ticked). Lists the library and the
 * cloud songs this laptop does not have, so a playlist can be made from cloud songs too.
 */
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
  private readonly cloud = inject(CloudService);

  /** Set when editing; absent when creating. */
  readonly id = input<number>();
  protected readonly name = signal('');
  protected readonly query = signal('');
  /** Ticked row keys in the order they will play. */
  protected readonly selected = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly cloudSongs = signal<CloudSong[]>([]);
  /** Songs of the playlist being edited that are neither in the library nor on the cloud: kept unless unticked. */
  private readonly kept = signal<Row[]>([]);

  private readonly rows = computed<Row[]>(() => [
    ...this.library.tracks().map((t) => ({
      key: `t:${t.id}`, title: t.title, artist: t.artist, album: t.album, tag: '' as const, ref: { trackId: t.id },
    })),
    ...this.cloudSongs()
      .filter((s) => !s.inLibrary)
      .map((s) => ({
        key: `c:${s.id}`, title: s.title, artist: s.artist, album: s.album, tag: 'cloud' as const, ref: { cloudId: s.id },
      })),
    ...this.kept(),
  ]);
  protected readonly visible = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.rows().filter((r) => words.every((w) => `${r.title} ${r.artist} ${r.album}`.toLowerCase().includes(w)));
  });
  protected readonly canSave = computed(() => this.name().trim().length > 0 && !this.saving());

  async ngOnInit(): Promise<void> {
    this.cloud
      .songs()
      .then((r) => this.cloudSongs.set(r.songs))
      .catch(() => {
        /* no cloud: library songs only */
      });
    const id = this.id();
    if (id === undefined) return;
    const playlist = await this.playlists.get(id);
    if (!playlist) {
      this.error.set('This playlist does not exist any more.');
      return;
    }
    this.name.set(playlist.name);
    const kept: Row[] = [];
    this.selected.set(
      playlist.songs.map((song: PlaylistSong, i) => {
        if (song.trackId !== null) return `t:${song.trackId}`;
        if (song.cloudId !== null) return `c:${song.cloudId}`;
        kept.push({ key: `k:${i}`, title: song.title, artist: song.artist, album: song.album, tag: 'not available', ref: song });
        return `k:${i}`;
      }),
    );
    this.kept.set(kept);
  }

  protected isSelected(row: Row): boolean {
    return this.selected().includes(row.key);
  }

  protected toggle(row: Row): void {
    this.selected.update((keys) => (keys.includes(row.key) ? keys.filter((k) => k !== row.key) : [...keys, row.key]));
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(null);
    const byKey = new Map(this.rows().map((r) => [r.key, r.ref]));
    // A ticked cloud song can be missing from the list if the cloud did not answer this time: keep it by id.
    const refs = this.selected().map((key) => byKey.get(key) ?? (key.startsWith('c:') ? { cloudId: Number(key.slice(2)) } : null));
    try {
      const id = this.id();
      const songs = refs.filter((r): r is SongRef => r !== null);
      const saved =
        id === undefined ? await this.playlists.create(this.name(), songs) : await this.playlists.update(id, this.name(), songs);
      this.nav.go({ page: 'playlist', id: saved.id }, { replace: true });
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}
