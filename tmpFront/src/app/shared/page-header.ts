import { Component, input } from '@angular/core';
import { NavService } from '../core/nav.service';
import { inject } from '@angular/core';

/** Title bar of every inner page: a back arrow, the title, and optional action buttons (projected content). */
@Component({
  selector: 'app-page-header',
  template: `
    <button type="button" class="back" aria-label="Back" (click)="nav.back()">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" fill="currentColor" />
      </svg>
    </button>
    <h1>{{ title() }}</h1>
    <span class="actions"><ng-content /></span>
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
    h1 { flex: 1; margin: 0; font-size: 1.6rem; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; gap: 8px; }
    .back { display: grid; place-items: center; flex: none; width: 38px; height: 38px; padding: 0; color: var(--text-strong);
      background: transparent; border: none; border-radius: 50%; cursor: pointer; }
    .back:hover { background: var(--hover); }
  `,
})
export class PageHeader {
  protected readonly nav = inject(NavService);
  readonly title = input.required<string>();
}
