import { Component, inject } from '@angular/core';
import { LibraryService } from '../../core/library.service';
import { LinkInput } from './link-input/link-input';
import { PageHeader } from '../../shared/page-header';

/**
 * Paste a YouTube / Spotify / Deezer link. The app keeps this page alive (only hidden) so a running download
 * keeps its progress view when you go to another page.
 */
@Component({
  imports: [PageHeader, LinkInput],
  selector: 'app-download-page',
  template: `
    <app-page-header title="Download new tracks" />
    <app-link-input (finished)="library.load()" />
  `,
})
export class DownloadPage {
  protected readonly library = inject(LibraryService);
}
