import { Component, OnInit, computed, inject } from '@angular/core';
import { NavService } from '../../core/nav.service';
import { CloudService, formatSize } from './cloud.service';

/** This month's cloud traffic as a bar (10 GB budget by default), plus the storage used. */
@Component({
  selector: 'app-cloud-usage',
  styles: `
    :host {
      display: block;
      margin-bottom: 16px;
      padding: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 0.9rem;
    }
    .line strong {
      font-variant-numeric: tabular-nums;
    }
    .muted {
      color: var(--text-muted);
    }
    .bar {
      height: 12px;
      margin: 8px 0;
      border-radius: 6px;
      background: var(--border);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      border-radius: 6px;
      background: var(--accent);
      transition: width 0.4s ease;
    }
    .fill.warning {
      background: var(--info);
    }
    .fill.reached {
      background: var(--danger);
    }
    .message {
      margin: 8px 0 0;
      font-weight: 600;
      color: var(--danger);
    }
    .link {
      padding: 0;
      color: var(--accent);
      font: inherit;
      background: none;
      border: none;
      text-decoration: underline;
      cursor: pointer;
    }
  `,
  template: `
    @if (status(); as s) {
      @if (!s.configured) {
        <span class="muted">The cloud is not set up yet. </span>
        <button type="button" class="link" (click)="nav.go({ page: 'settings' })">Open Settings</button>
      } @else if (s.error) {
        <span class="message" role="alert">{{ s.error }}</span>
      } @else {
        <div class="line">
          <span
            >This month: <strong>{{ size(s.usedBytes ?? 0) }}</strong> of {{ size(s.limitBytes ?? 0) }}</span
          >
          <strong>{{ s.percent }} %</strong>
        </div>
        <div
          class="bar"
          role="progressbar"
          aria-label="Cloud traffic used this month"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="s.percent"
        >
          <div class="fill" [class.warning]="s.warning" [class.reached]="s.reached" [style.width.%]="s.percent"></div>
        </div>
        <div class="line muted">
          <span>Stored: {{ size(s.storedBytes ?? 0) }} of {{ size(s.storageLimitBytes ?? 0) }}</span>
          @if (s.warning && !s.reached) {
            <span>Over 80 % of this month's budget used.</span>
          }
        </div>
        @if (s.message) {
          <p class="message" role="alert">{{ s.message }}</p>
        }
      }
    } @else {
      <span class="muted">Checking cloud usage...</span>
    }
  `,
})
export class CloudUsage implements OnInit {
  protected readonly nav = inject(NavService);
  private readonly cloud = inject(CloudService);
  protected readonly status = computed(() => this.cloud.status());
  protected readonly size = formatSize;

  ngOnInit(): void {
    void this.cloud.loadStatus();
  }
}
