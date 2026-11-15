import { Component, computed, inject, signal } from '@angular/core';
import { coverUrl, formatTime } from '../core/api';
import { PlayerService } from '../core/player.service';

/** Fixed bar at the bottom: now playing, previous / play-pause / next, seek bar and volume. */
@Component({
  selector: 'app-player-bar',
  templateUrl: './player-bar.html',
  styleUrl: './player-bar.css',
})
export class PlayerBar {
  protected readonly player = inject(PlayerService);
  protected readonly formatTime = formatTime;
  protected readonly coverUrl = coverUrl;

  /** The seek thumb follows the slider while it is being dragged, then the song jumps on release. */
  private readonly dragging = signal<number | null>(null);
  protected readonly shownPosition = computed(() => this.dragging() ?? this.player.position());
  protected readonly coverMissing = signal<number | null>(null);

  protected onSeekInput(event: Event): void {
    this.dragging.set(Number((event.target as HTMLInputElement).value));
  }

  protected onSeekCommit(event: Event): void {
    this.player.seek(Number((event.target as HTMLInputElement).value));
    this.dragging.set(null);
  }

  protected onVolume(event: Event): void {
    this.player.setVolume(Number((event.target as HTMLInputElement).value));
  }
}
