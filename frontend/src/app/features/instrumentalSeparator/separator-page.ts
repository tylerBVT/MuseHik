import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Track, coverUrl, formatTime, streamUrl } from '../../core/api';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../musicPlayer/player.service';
import { PlaylistService } from '../musicPlayer/playlist.service';
import { PageHeader } from '../../shared/page-header';
import { SeparationResult, SeparatorService } from './separator.service';

/**
 * Pick one song from the library (all songs or one playlist, filtered by name), pick a method, and get its
 * instrumental. The work runs on the server (Python + GPU); finished instrumentals are saved in the music folder,
 * added to the library, and can be played and compared with the original right here.
 */
@Component({
  imports: [PageHeader],
  selector: 'app-separator-page',
  styleUrl: './separator-page.css',
  templateUrl: './separator-page.html',
})
export class SeparatorPage {
  protected readonly library = inject(LibraryService);
  private readonly playlistService = inject(PlaylistService);
  private readonly player = inject(PlayerService);
  protected readonly separator = inject(SeparatorService);
  protected readonly playlists = this.playlistService.playlists;
  protected readonly coverUrl = coverUrl;
  protected readonly streamUrl = streamUrl;
  protected readonly formatTime = formatTime;

  /** 'all' or a playlist id: where the songs come from. */
  protected readonly scope = signal<'all' | number>('all');
  /** Songs of the chosen playlist (loaded on demand); null while loading or when the scope is 'all'. */
  private readonly playlistTracks = signal<Track[] | null>(null);
  protected readonly query = signal('');
  protected readonly selected = signal<Track | null>(null);
  protected readonly method = signal('best');
  protected readonly results = signal<SeparationResult[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly starting = signal(false);

  protected readonly source = computed(() => (this.scope() === 'all' ? this.library.tracks() : (this.playlistTracks() ?? [])));
  protected readonly visible = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.source().filter((t) => {
      const text = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
  /** The queued/running separation of the selected song. */
  protected readonly job = computed(() => {
    const track = this.selected();
    this.separator.jobs();
    return track ? this.separator.activeFor(track.id) : null;
  });
  /** The last failed job of the selected song + method, to say why. */
  protected readonly failure = computed(() => {
    const track = this.selected();
    this.separator.jobs();
    const last = track ? this.separator.lastFor(track.id, this.method()) : null;
    return last?.status === 'failed' ? last : null;
  });
  protected readonly canStart = computed(() => !!this.selected() && !this.job() && !this.starting() && this.separator.available());
  protected readonly methodName = (id: string) => this.separator.methods().find((m) => m.id === id)?.name ?? id;
  protected readonly hasResult = (id: string) => this.results().some((r) => r.method === id);

  constructor() {
    void this.separator.loadMethods().catch((e: Error) => this.error.set(e.message));

    // Load the songs of the chosen playlist; ignore an answer that arrives after the scope changed again.
    effect(() => {
      const scope = this.scope();
      this.playlistTracks.set(null);
      if (scope === 'all') return;
      void this.playlistService.get(scope).then((playlist) => {
        if (this.scope() === scope) this.playlistTracks.set(playlist?.tracks ?? []);
      });
    });

    // Results of the selected song: on selection, and again whenever a separation finishes.
    effect(() => {
      const track = this.selected();
      this.separator.finished();
      untracked(() => void this.loadResults(track));
    });

    // A finished instrumental is a new song in the library (saved in the music folder): refresh the song lists.
    let seen = this.separator.finished();
    effect(() => {
      const count = this.separator.finished();
      if (count !== seen) {
        seen = count;
        untracked(() => void this.library.load());
      }
    });
  }

  protected setScope(value: string): void {
    this.scope.set(value === 'all' ? 'all' : Number(value));
  }

  protected select(track: Track): void {
    this.selected.set(this.selected()?.id === track.id ? null : track);
    this.error.set(null);
  }

  protected async getInstrumental(): Promise<void> {
    const track = this.selected();
    if (!track || !this.canStart()) return;
    this.starting.set(true);
    this.error.set(null);
    try {
      await this.separator.start(track.id, this.method());
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.starting.set(false);
    }
  }

  protected async stop(): Promise<void> {
    const job = this.job();
    if (job) await this.separator.cancel(job);
  }

  protected async remove(method: string): Promise<void> {
    const track = this.selected();
    if (!track) return;
    await this.separator.remove(track.id, method);
    await this.loadResults(track);
    await this.library.load(); // the instrumental was also a song in the library
  }

  /** Only one thing plays at a time: pause the main player and the other previews on this page. */
  protected onPreviewPlay(event: Event): void {
    if (this.player.playing()) this.player.toggle();
    for (const audio of Array.from(document.querySelectorAll<HTMLAudioElement>('app-separator-page audio'))) {
      if (audio !== event.target) audio.pause();
    }
  }

  private async loadResults(track: Track | null): Promise<void> {
    if (!track) {
      this.results.set([]);
      return;
    }
    try {
      const data = await this.separator.results(track.id);
      if (this.selected()?.id === track.id) this.results.set(data.results);
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }
}
