import { Component, inject, signal } from '@angular/core';
import { AppSettingsService } from '../core/app-settings.service';
import { LibraryService } from '../core/library.service';
import { NavService } from '../core/nav.service';
import { hasServer } from '../core/platform';
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
  /** MuttMutt does not see the AI tools. */
  protected readonly app = inject(AppSettingsService);
  private readonly playlistService = inject(PlaylistService);
  protected readonly playlists = this.playlistService.playlists;
  /** This laptop's name on shared playlists, to tell mine from the other laptop's. */
  private readonly myName = signal<string | null>(null);
  /** Set up but switched to Offline on this laptop: the cloud tiles say so. */
  protected readonly cloudOff = signal(false);

  /** False on the phone: the tiles that need the laptop's tools (downloader, separator) are hidden. */
  protected readonly hasServer = hasServer;

  constructor() {
    // Picks up playlists shared from the other laptop (the server skips it if it synced in the last 30 s).
    void this.playlistService.sync();
    inject(CloudService)
      .getSettings()
      .then((s) => {
        this.myName.set(s.displayName);
        this.cloudOff.set(Boolean(s.url && s.hasKey) && !cloudOnline(s));
      })
      .catch(() => {});
  }

  /** "Shared" on mine, "from Mum" on the other laptop's, nothing on private ones. */
  protected sharing(playlist: PlaylistSummary): string {
    if (!playlist.shared) return '';
    return playlist.owner && this.myName() !== null && playlist.owner !== this.myName() ? `from ${playlist.owner}` : 'Shared';
  }
}
