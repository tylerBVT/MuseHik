import { Component, inject } from '@angular/core';
import { PageHeader } from '../shared/page-header';
import { ThemeChoice, ThemeService } from '../core/theme.service';

@Component({
  imports: [PageHeader],
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  protected readonly theme = inject(ThemeService);

  protected readonly themes: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
}
