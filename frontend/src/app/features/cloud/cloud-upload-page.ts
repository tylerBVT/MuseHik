import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { LibraryService } from '../../core/library.service';
import { PageHeader } from '../../shared/page-header';
import { PlaylistService } from '../musicPlayer/playlist.service';
import { CloudService, FolderSong, UploadJob, formatSize } from './cloud.service';
import { CloudUsage } from './usage-bar';

type Tab = 'songs' | 'playlist' | 'folder';
type Row = { key: string; title: string; artist: string; size: number };

/** Send songs to the cloud: picked from All tracks, a whole playlist, or any folder on this laptop. */
@Component({
  imports: [PageHeader, CloudUsage],
  selector: 'app-cloud-upload-page',
  templateUrl: './cloud-upload-page.html',
  styleUrl: './cloud-upload-page.css',
})
export class CloudUploadPage implements OnInit, OnDestroy {
  protected readonly cloud = inject(CloudService);
  protected readonly library = inject(LibraryService);
  protected readonly playlists = inject(PlaylistService);
  protected readonly size = formatSize;

  protected readonly tab = signal<Tab>('songs');
  protected readonly query = signal('');
  /** Library song ids ticked on the Songs tab. */
  protected readonly pickedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly playlistId = signal<number | null>(null);
  protected readonly playlistRows = signal<Row[]>([]);
  protected readonly folder = signal('');
  protected readonly folderSongs = signal<FolderSong[]>([]);
  /** Folder files ticked (all by default). */
  protected readonly pickedPaths = signal<ReadonlySet<string>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly job = signal<UploadJob | null>(null);
  private polling: ReturnType<typeof setTimeout> | null = null;

  protected readonly libraryRows = computed<Row[]>(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.library
      .tracks()
      .filter((t) => words.every((w) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(w)))
      .map((t) => ({ key: String(t.id), title: t.title, artist: t.artist, size: t.size ?? 0 }));
  });
  protected readonly folderRows = computed<Row[]>(() =>
    this.folderSongs().map((s) => ({ key: s.path, title: s.title, artist: s.artist, size: s.size })),
  );

  /** What the Upload button would send, and its total size. */
  protected readonly selection = computed(() => {
    const tab = this.tab();
    if (tab === 'songs') {
      const ids = [...this.pickedIds()];
      const sizes = new Map(this.library.tracks().map((t) => [t.id, t.size ?? 0]));
      return { trackIds: ids, paths: [], count: ids.length, bytes: ids.reduce((s, id) => s + (sizes.get(id) ?? 0), 0) };
    }
    if (tab === 'playlist') {
      const rows = this.playlistRows();
      return { trackIds: rows.map((r) => Number(r.key)), paths: [], count: rows.length, bytes: rows.reduce((s, r) => s + r.size, 0) };
    }
    const picked = this.pickedPaths();
    const rows = this.folderSongs().filter((s) => picked.has(s.path));
    return { trackIds: [], paths: rows.map((r) => r.path), count: rows.length, bytes: rows.reduce((s, r) => s + r.size, 0) };
  });

  protected readonly leftThisMonth = computed(() => {
    const s = this.cloud.status();
    return s?.limitBytes !== undefined && s.usedBytes !== undefined ? Math.max(0, s.limitBytes - s.usedBytes) : null;
  });
  protected readonly running = computed(() => this.job()?.state === 'running');
  protected readonly canUpload = computed(
    () => this.selection().count > 0 && !this.running() && !this.busy() && !this.cloud.status()?.reached,
  );
  protected readonly percent = computed(() => {
    const job = this.job();
    return job && job.bytesTotal ? Math.round((job.bytesDone / job.bytesTotal) * 100) : 0;
  });

  async ngOnInit(): Promise<void> {
    const active = await this.cloud.activeUpload().catch(() => null);
    if (active) this.follow(active);
  }

  ngOnDestroy(): void {
    if (this.polling) clearTimeout(this.polling);
  }

  protected setTab(tab: Tab): void {
    this.tab.set(tab);
    this.error.set(null);
  }

  protected toggleId(key: string): void {
    const id = Number(key);
    this.pickedIds.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected togglePath(path: string): void {
    this.pickedPaths.update((set) => {
      const next = new Set(set);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  protected selectAllVisible(): void {
    this.pickedIds.update((set) => new Set([...set, ...this.libraryRows().map((r) => Number(r.key))]));
  }

  protected clearPicked(): void {
    this.pickedIds.set(new Set());
  }

  protected async choosePlaylist(id: number): Promise<void> {
    this.playlistId.set(id);
    const playlist = await this.playlists.get(id);
    const sizes = new Map(this.library.tracks().map((t) => [t.id, t.size ?? 0]));
    this.playlistRows.set(
      (playlist?.tracks ?? []).map((t) => ({ key: String(t.id), title: t.title, artist: t.artist, size: sizes.get(t.id) ?? 0 })),
    );
  }

  protected async pickFolder(): Promise<void> {
    this.busy.set(true);
    try {
      const { path } = await this.cloud.pickFolder();
      if (path) {
        this.folder.set(path);
        await this.listFolder();
      }
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async listFolder(): Promise<void> {
    const path = this.folder().trim();
    if (!path) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const { songs } = await this.cloud.scanFolder(path);
      this.folderSongs.set(songs);
      this.pickedPaths.set(new Set(songs.map((s) => s.path)));
    } catch (e) {
      this.folderSongs.set([]);
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async upload(): Promise<void> {
    if (!this.canUpload()) return;
    this.error.set(null);
    const { trackIds, paths } = this.selection();
    try {
      const { jobId } = await this.cloud.startUpload({ trackIds, paths });
      this.follow(await this.cloud.getUpload(jobId));
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  protected async stop(): Promise<void> {
    const job = this.job();
    if (job) this.job.set(await this.cloud.cancelUpload(job.id));
  }

  /** Polls the job until it ends, then refreshes the usage bar. */
  private follow(job: UploadJob): void {
    this.job.set(job);
    if (job.state !== 'running') {
      void this.cloud.loadStatus();
      return;
    }
    this.polling = setTimeout(async () => {
      try {
        this.follow(await this.cloud.getUpload(job.id));
      } catch (e) {
        this.error.set((e as Error).message);
      }
    }, 700);
  }
}
