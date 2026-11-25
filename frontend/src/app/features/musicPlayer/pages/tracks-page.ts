import { Component, inject } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { LibraryList } from '../library-list/library-list';
import { PageHeader } from '../../../shared/page-header';
import { hasServer } from '../../../core/platform';

/** Every song in the library. */
@Component({
  imports: [PageHeader, LibraryList],
  selector: 'app-tracks-page',
  template: `
    <app-page-header title="All tracks" />
    <app-library-list
      heading="Songs"
      [tracks]="library.tracks()"
      [sortable]="true"
      (changed)="library.load()"
      [emptyMessage]="emptyMessage"
    />
  `,
})
export class TracksPage {
  protected readonly library = inject(LibraryService);
  protected readonly emptyMessage = hasServer
    ? 'Your library is empty. Use “Download new tracks” on the main page to add music.'
    : 'No songs saved on this phone yet. Use “Download from cloud”, or a song’s ⋮ menu on the Cloud page, to save songs here.';
}
