import { Component, inject, signal } from '@angular/core';
import { LibraryService } from '../core/library.service';
import { NavService } from '../core/nav.service';
import { CloudService, cloudOnline } from '../features/cloud/cloud.service';
import { PlaylistService, PlaylistSummary } from '../features/musicPlayer/playlist.service';

/** The main page: big icon tiles leading to every other page, including each playlist. */
@Component({
  selector: 'app-home',
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  protected readonly nav = inject(NavService);
  protected readonly library = inject(LibraryService);
  private readonly playlistService = inject(PlaylistService);
  protected readonly playlists = this.playlistService.playlists;
  /** This laptop's name on shared playlists, to tell mine from the other laptop's. */
  private readonly myName = signal<string | null>(null);
  /** Set up but switched to Offline on this laptop: the cloud tiles say so. */
  protected readonly cloudOff = signal(false);

  constructor() {
    // Picks up playlists shared from the other laptop (the server skips it if it synced in the last 30 s).
    void this.playlistService.sync();
    inject(CloudService)
      .getSettings()
      .then((s) => {
        this.myName.set(s.displayName);
        this.cloudOff.set(Boolean(s.host && s.user && s.hasPassword) && !cloudOnline(s));
      })
      .catch(() => {});
  }

  /** "Shared" on mine, "from Mum" on the other laptop's, nothing on private ones. */
  protected sharing(playlist: PlaylistSummary): string {
    if (!playlist.shared) return '';
    return playlist.owner && this.myName() !== null && playlist.owner !== this.myName() ? `from ${playlist.owner}` : 'Shared';
  }
}
