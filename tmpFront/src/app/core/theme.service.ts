import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'musehik.theme';

/** Light / dark / follow-the-system. Writes data-theme="light|dark" on <html>; the colours are in theme.css. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');

  readonly choice = signal<ThemeChoice>(this.stored());
  private readonly systemDark = signal(this.media?.matches ?? false);

  constructor() {
    this.media?.addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const choice = this.choice();
      const dark = choice === 'dark' || (choice === 'system' && this.systemDark());
      this.doc.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    });
  }

  set(choice: ThemeChoice): void {
    this.choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      /* storage unavailable: the choice just lasts until reload */
    }
  }

  private stored(): ThemeChoice {
    try {
      const value = localStorage.getItem(KEY);
      if (value === 'light' || value === 'dark' || value === 'system') return value;
    } catch {
      /* ignore */
    }
    return 'system';
  }
}
