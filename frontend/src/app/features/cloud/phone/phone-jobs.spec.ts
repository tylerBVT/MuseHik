import { MusicApiError, type ApiSong } from '../music-api';
import { runSave, runUpload, type SongTags } from './phone-jobs';

const song = (id: number, title: string, artist = 'Band'): ApiSong => ({
  id, file: `${artist} - ${title}.mp3`, title, artist, album: '', duration: 100, isrc: null, key: '', size: 1000,
  addedBy: 'laptop', addedAt: '2026-01-01T00:00:00.000Z',
});
const file = (name: string, bytes = 1000) => new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });
const tagsFromName = async (f: File): Promise<SongTags> => {
  const [artist, title] = f.name.replace(/\.\w+$/, '').split(' - ');
  return { title, artist, album: 'Al', duration: 120, isrc: null };
};

describe('runUpload (the phone sends files to the cloud)', () => {
  it('uploads each file with its tags and this phone as sender, counting bytes', async () => {
    const sent: unknown[] = [];
    const api = {
      upload: async (blob: Blob, name: string, fields: object, opts: { onProgress?: (s: number, t: number) => void }) => {
        opts.onProgress?.(blob.size / 2, blob.size);
        opts.onProgress?.(blob.size, blob.size);
        sent.push({ name, fields });
        return song(sent.length, name);
      },
    };
    const run = runUpload([file('A - One.mp3'), file('B - Two.mp3', 3000)], { api, readTags: tagsFromName, addedBy: 'Phone' });
    await run.done;
    expect(run.job.state).toBe('done');
    expect(run.job.uploaded.map((u) => u.title)).toEqual(['One', 'Two']);
    expect(run.job.done).toBe(2);
    expect(run.job.bytesTotal).toBe(4000);
    expect(run.job.bytesDone).toBe(4000);
    expect(sent[0]).toEqual({ name: 'A - One.mp3', fields: { title: 'One', artist: 'A', album: 'Al', duration: 120, isrc: null, addedBy: 'Phone' } });
  });

  it('a twin is skipped, a full cloud fails the rest, any other error fails that song only', async () => {
    const api = {
      upload: async (_b: Blob, name: string) => {
        if (name.startsWith('Twin')) throw new MusicApiError('This song is already on the cloud.', 409, song(9, 'Old', 'Twin'));
        if (name.startsWith('Bad')) throw new MusicApiError('Only audio files can be uploaded.', 415);
        if (name.startsWith('Full')) throw new MusicApiError('Not enough cloud storage: 0.00 GB free of 30 GB.', 413);
        return song(1, name);
      },
    };
    const files = ['Twin - X.mp3', 'Bad - Y.mp3', 'Ok - Z.mp3', 'Full - A.mp3', 'Late - B.mp3'].map((n) => file(n));
    const run = runUpload(files, { api, readTags: tagsFromName, addedBy: 'Phone' });
    await run.done;
    expect(run.job.skipped).toEqual([{ title: 'X', artist: 'Twin', file: 'Twin - X.mp3', reason: 'Already on the cloud as "Twin - Old"' }]);
    expect(run.job.failed.map((f) => [f.title, f.reason])).toEqual([
      ['Y', 'Only audio files can be uploaded.'],
      ['A', 'Not enough cloud storage: 0.00 GB free of 30 GB.'],
      ['B', 'Not enough cloud storage: 0.00 GB free of 30 GB.'],
    ]);
    expect(run.job.uploaded.map((u) => u.title)).toEqual(['Z']);
    expect(run.job.done).toBe(run.job.total);
    expect(run.job.state).toBe('done');
    expect(run.job.bytesDone).toBe(run.job.bytesTotal); // every file was dealt with: the bar is full
  });

  it('a file whose tags cannot be read is sent with what its name says', async () => {
    const seen: object[] = [];
    const api = { upload: async (_b: Blob, _n: string, fields: object) => (seen.push(fields), song(1, 'x')) };
    const run = runUpload([file('Artist - Title.mp3')], { api, readTags: () => Promise.reject(new Error('bad tags')), addedBy: 'Phone' });
    await run.done;
    expect(seen[0]).toEqual({ title: 'Title', artist: 'Artist', addedBy: 'Phone' });
  });

  it('stop aborts the song being sent and stops there', async () => {
    let calls = 0;
    const api = {
      upload: (_b: Blob, _n: string, _f: object, opts: { signal?: AbortSignal }) => {
        calls++;
        return new Promise<ApiSong>((_resolve, reject) =>
          opts.signal?.addEventListener('abort', () => reject(new MusicApiError('stopped.'))));
      },
    };
    const run = runUpload([file('A - 1.mp3'), file('A - 2.mp3')], { api, readTags: tagsFromName, addedBy: 'Phone' });
    await new Promise((r) => setTimeout(r, 0));
    run.cancel();
    await run.done;
    expect(run.job.state).toBe('stopped');
    expect(calls).toBe(1);
    expect(run.job.uploaded).toEqual([]);
    expect(run.job.failed).toEqual([]);
    expect(run.job.bytesDone).toBe(0);
  });
});

describe('runSave (cloud songs saved on the phone)', () => {
  it('saves each song once; songs already on the phone are skipped; failures say why', async () => {
    const list = [song(1, 'One'), song(2, 'Two'), song(3, 'Three')];
    const saved: number[] = [];
    const run = runSave([1, 2, 3, 99], {
      songs: list,
      isSaved: (id) => id === 2,
      save: async (s) => {
        if (s.id === 3) throw new Error('No space left on the phone.');
        saved.push(s.id);
      },
    });
    await run.done;
    expect(saved).toEqual([1]);
    expect(run.job.total).toBe(3);
    expect(run.job.saved).toEqual([{ id: 1, title: 'One', artist: 'Band', file: 'Band - One.mp3' }]);
    expect(run.job.skipped).toEqual([{ id: 2, title: 'Two', artist: 'Band', reason: 'Already on this phone' }]);
    expect(run.job.failed).toEqual([{ id: 3, title: 'Three', artist: 'Band', reason: 'No space left on the phone.' }]);
    expect(run.job.state).toBe('done');
  });

  it('stop ends after the song being saved', async () => {
    let release!: () => void;
    const saved: number[] = [];
    const run = runSave([1, 2], {
      songs: [song(1, 'One'), song(2, 'Two')],
      isSaved: () => false,
      save: (s) => new Promise<void>((resolve) => { release = () => { saved.push(s.id); resolve(); }; }),
    });
    await new Promise((r) => setTimeout(r, 0));
    run.cancel();
    release();
    await run.done;
    expect(saved).toEqual([1]);
    expect(run.job.state).toBe('stopped');
  });
});
