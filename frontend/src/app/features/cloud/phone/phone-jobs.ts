// The phone's upload and save jobs: the same shapes as the laptop server's jobs (backend/modules/cloud/upload.mjs and
// save.mjs), so the Cloud upload and Download from cloud pages follow them the same way. They run inside the app.
import type { SaveItem, SaveJob, UploadItem, UploadJob } from '../cloud.service';
import { MusicApiError, type ApiSong, type MusicApi, type UploadFields } from '../music-api';

/** What a song file says about itself (read on the phone, like the laptops read tags before uploading). */
export type SongTags = { title: string; artist: string; album: string; duration: number; isrc: string | null };

const label = (s: { title: string; artist: string }) => (s.artist ? `${s.artist} - ${s.title}` : s.title);

/** "Artist - Title.mp3" → its artist and title (what the server would also guess). */
function fromName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '');
  const dash = base.indexOf(' - ');
  return dash > 0 ? { artist: base.slice(0, dash), title: base.slice(dash + 3) } : { artist: '', title: base };
}

export type UploadDeps = {
  api: Pick<MusicApi, 'upload'>;
  readTags: (file: File) => Promise<SongTags>;
  /** Shown as "added by" on the cloud. */
  addedBy: string;
};

export type Running<J> = { job: J; cancel: () => void; done: Promise<void> };

/** Sends the files one by one. 409: already there (skipped); 413 "not enough storage": every song left fails. */
export function runUpload(files: File[], deps: UploadDeps): Running<UploadJob> {
  const job: UploadJob = {
    id: crypto.randomUUID(), state: 'running', total: files.length, done: 0, bytesDone: 0,
    bytesTotal: files.reduce((sum, f) => sum + f.size, 0), current: null, uploaded: [], skipped: [], failed: [], error: null,
  };
  const stop = new AbortController();

  async function run(): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      if (stop.signal.aborted) break;
      const file = files[i];
      let fields: UploadFields;
      try {
        const tags = await deps.readTags(file);
        fields = { ...tags, addedBy: deps.addedBy };
      } catch {
        fields = { ...fromName(file.name), addedBy: deps.addedBy };
      }
      const named = { title: fields.title ?? '', artist: fields.artist ?? '', file: file.name };
      const item = (extra: Partial<UploadItem> = {}): UploadItem => ({ ...named, ...extra });
      job.current = label(named);
      const start = job.bytesDone;
      try {
        const saved = await deps.api.upload(file, file.name, fields, {
          signal: stop.signal,
          onProgress: (sent) => {
            job.bytesDone = start + sent;
          },
        });
        job.bytesDone = start + file.size;
        job.uploaded.push(item({ file: saved.file }));
      } catch (e) {
        job.bytesDone = start;
        if (stop.signal.aborted) break;
        // Dealt with (skipped or failed): its bytes count as done, so a finished job shows a full bar.
        job.bytesDone = start + file.size;
        const error = e as MusicApiError;
        if (error.status === 409 && error.song) {
          job.skipped.push(item({ reason: `Already on the cloud as "${label(error.song)}"` }));
        } else if (error.status === 413 && /Not enough cloud storage/.test(error.message)) {
          for (const rest of files.slice(i)) {
            const restNamed = rest === file ? named : { ...fromName(rest.name), file: rest.name };
            job.failed.push({ ...restNamed, reason: error.message });
          }
          job.done = job.total;
          job.bytesDone = job.bytesTotal;
          break;
        } else {
          job.failed.push(item({ reason: error.message }));
        }
      }
      job.done++;
    }
    job.current = null;
    job.state = stop.signal.aborted ? 'stopped' : 'done';
  }

  const done = run().catch((e) => {
    job.state = 'failed';
    job.error = (e as Error).message;
  });
  return { job, cancel: () => stop.abort(), done };
}

export type SaveDeps = {
  /** The cloud list (fresh, or the last one seen). */
  songs: ApiSong[];
  isSaved: (id: number) => boolean;
  /** Downloads the song's file and adds it to the phone's songs. */
  save: (song: ApiSong) => Promise<void>;
};

/** Saves cloud songs on the phone, one by one. Stop ends after the song being saved (a download cannot be cut). */
export function runSave(ids: number[], deps: SaveDeps): Running<SaveJob> {
  const songs = ids.map((id) => deps.songs.find((s) => s.id === id)).filter((s): s is ApiSong => Boolean(s));
  const job: SaveJob = {
    id: crypto.randomUUID(), state: 'running', total: songs.length, done: 0, current: null,
    saved: [], skipped: [], failed: [], error: null,
  };
  let stopped = false;
  const item = (s: ApiSong, extra: Partial<SaveItem> = {}): SaveItem => ({ id: s.id, title: s.title, artist: s.artist, ...extra });

  async function run(): Promise<void> {
    for (const song of songs) {
      if (stopped) break;
      job.current = label(song);
      if (deps.isSaved(song.id)) {
        job.skipped.push(item(song, { reason: 'Already on this phone' }));
      } else {
        try {
          await deps.save(song);
          job.saved.push(item(song, { file: song.file }));
        } catch (e) {
          job.failed.push(item(song, { reason: (e as Error).message }));
        }
      }
      job.done++;
    }
    job.current = null;
    job.state = stopped ? 'stopped' : 'done';
  }

  const done = run().catch((e) => {
    job.state = 'failed';
    job.error = (e as Error).message;
  });
  return { job, cancel: () => (stopped = true), done };
}
