import { Component, computed, inject } from '@angular/core';
import { LibraryService } from './core/library.service';
import { NavService } from './core/nav.service';
import { PlaylistService } from './core/playlist.service';
import { ThemeService } from './core/theme.service';
import { Home } from './home/home';
import { DownloadPage } from './pages/download-page';
import { PlaylistEditor } from './pages/playlist-editor';
import { PlaylistPage } from './pages/playlist-page';
import { TracksPage } from './pages/tracks-page';
import { PlayerBar } from './player-bar/player-bar';
import { Settings } from './settings/settings';

@Component({
  imports: [Home, TracksPage, DownloadPage, PlaylistPage, PlaylistEditor, Settings, PlayerBar],
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
