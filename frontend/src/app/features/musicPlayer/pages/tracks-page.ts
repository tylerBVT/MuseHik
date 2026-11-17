import { Component, inject } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { LibraryList } from '../library-list/library-list';
import { PageHeader } from '../../../shared/page-header';

/** Every song in the library. */
@Component({
  imports: [PageHeader, LibraryList],
  selector: 'app-tracks-page',
  template: `
    <app-page-header title="All tracks" />
    <app-library-list
      heading="Songs"
      [tracks]="library.tracks()"
      emptyMessage="Your library is empty. Use “Download new tracks” on the main page to add music."
    />
  `,
})
export class TracksPage {
  protected readonly library = inject(LibraryService);
}
