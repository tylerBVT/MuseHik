import { Component, computed, inject } from '@angular/core';
import { LibraryService } from './core/library.service';
import { NavService } from './core/nav.service';
import { PlaylistService } from './features/musicPlayer/playlist.service';
import { ThemeService } from './core/theme.service';
import { Home } from './home/home';
import { DownloadPage } from './features/musicDownloader/download-page';
import { SeparatorPage } from './features/instrumentalSeparator/separator-page';
import { PlaylistEditor } from './features/musicPlayer/pages/playlist-editor';
import { PlaylistPage } from './features/musicPlayer/pages/playlist-page';
import { TracksPage } from './features/musicPlayer/pages/tracks-page';
import { PlayerBar } from './features/musicPlayer/player-bar/player-bar';
import { Settings } from './settings/settings';
import { CloudPage } from './features/cloud/cloud-page';
import { CloudUploadPage } from './features/cloud/cloud-upload-page';

@Component({
  imports: [Home, TracksPage, DownloadPage, SeparatorPage, PlaylistPage, PlaylistEditor, Settings, PlayerBar, CloudPage, CloudUploadPage],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly nav = inject(NavService);
  /** Creating it applies the saved theme right at startup. */
  private readonly theme = inject(ThemeService);

  protected readonly page = computed(() => this.nav.view().page);
  /** The playlist being shown or edited, when the current page is about one. */
  protected readonly playlistId = computed(() => {
    const view = this.nav.view();
    return view.page === 'playlist' || view.page === 'edit' ? view.id : undefined;
  });

  constructor() {
    void inject(LibraryService).load();
    void inject(PlaylistService).load();
  }
}
