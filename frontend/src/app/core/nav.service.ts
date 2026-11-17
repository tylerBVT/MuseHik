import { Injectable, signal } from '@angular/core';

export type View =
  | { page: 'home' }
  | { page: 'settings' }
  | { page: 'tracks' }
  | { page: 'download' }
  | { page: 'separate' }
  | { page: 'create' }
  | { page: 'playlist'; id: number }
  | { page: 'edit'; id: number };

const HOME: View = { page: 'home' };

/**
 * Which page is shown. No router: the page is a signal, and each move is also pushed into the browser history,
 * so the browser's Back button (and Android's back gesture later) goes to the previous page.
 */
@Injectable({ providedIn: 'root' })
export class NavService {
  readonly view = signal<View>(HOME);
  private depth = 0;

  constructor() {
    history.replaceState({ view: HOME, depth: 0 }, '');
    window.addEventListener('popstate', (event) => {
      const state = event.state as { view: View; depth: number } | null;
      this.view.set(state?.view ?? HOME);
      this.depth = state?.depth ?? 0;
    });
  }

  go(view: View, options: { replace?: boolean } = {}): void {
    if (options.replace) {
      history.replaceState({ view, depth: this.depth }, '');
    } else {
      this.depth++;
      history.pushState({ view, depth: this.depth }, '');
    }
    this.view.set(view);
  }

  /** One page back; from a page reached directly (nothing before it) it goes home. */
  back(): void {
    if (this.depth > 0) history.back();
    else this.go(HOME, { replace: true });
  }
}
