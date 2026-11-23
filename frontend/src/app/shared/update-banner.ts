import { Component, signal } from '@angular/core';
import { desktop } from '../core/desktop';

/** Desktop app only: shown once a new version has been downloaded. */
@Component({
  selector: 'app-update-banner',
  template: `
    @if (version()) {
      <div class="banner" role="status">
        <span>A new version of MuseHik is ready.</span>
        <button type="button" (click)="restart()">Restart now</button>
      </div>
    }
  `,
  styles: `
    .banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 10px 16px;
      background: var(--accent);
      color: var(--on-accent);
      font-weight: 600;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 6px 16px;
      font: inherit;
      cursor: pointer;
      background: var(--surface);
      color: var(--text);
    }
  `,
})
export class UpdateBanner {
  protected readonly version = signal('');

  constructor() {
    desktop?.onUpdateReady((version) => this.version.set(version));
  }

  protected restart(): void {
    desktop?.restartToUpdate();
  }
}
