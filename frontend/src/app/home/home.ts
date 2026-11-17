import { Component, inject } from '@angular/core';
import { LibraryService } from '../core/library.service';
import { NavService } from '../core/nav.service';
import { PlaylistService } from '../features/musicPlayer/playlist.service';

/** The main page: big icon tiles leading to every other page, including each playlist. */
@Component({
  selector: 'app-home',
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  protected readonly nav = inject(NavService);
  protected readonly library = inject(LibraryService);
  protected readonly playlists = inject(PlaylistService).playlists;
}
