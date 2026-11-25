// The phone's way into the cloud: calls to the music API (music-api/ on the hosting) with the key from Settings.
// No imports and only plain TypeScript, so the backend tests run this very file against the real PHP API
// (backend/tests/phone-music-api.test.mjs). The laptops use their own client (backend/modules/cloud/api.mjs), with
// the same sentences for the same failures.

export type ApiSettings = { url: string; key: string };

export type ApiSong = {
  id: number;
  file: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc: string | null;
  key: string;
  size: number;
  addedBy: string;
  addedAt: string;
  genre?: string;
};

/** A song of a shared playlist; `songId` is the cloud song it plays (null: not on the cloud). */
export type ApiPlaylistSong = {
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc: string | null;
  key: string;
  songId: number | null;
};

export type ApiPlaylist = { id: string; name: string; owner: string; updatedAt: number; songs: ApiPlaylistSong[] };

/** What a playlist is made of when sent: a cloud song by id, or a song kept by its details. */
export type ApiPlaylistRef = { id: number } | { title: string; artist: string; album?: string; duration?: number; isrc?: string | null; key?: string };

export type UploadFields = { title?: string; artist?: string; album?: string; duration?: number; isrc?: string | null; addedBy?: string };

/** A failed call. `status`: the server's HTTP status (0 when it was not reached); `song`: the twin on a 409. */
export class MusicApiError extends Error {
  status: number;
  song: ApiSong | null;
  constructor(message: string, status = 0, song: ApiSong | null = null) {
    super(message);
    this.status = status;
    this.song = song;
  }
}

const TIMEOUT_MS = 30_000;

/** "www.example.com/music-api/" → "https://www.example.com/music-api"; '' stays ''. Throws on nonsense. */
export function cleanUrl(url: string): string {
  let value = String(url ?? '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, '');
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || /\s/.test(value)) throw new Error('bad');
  } catch {
    throw new Error('The cloud address must look like https://www.example.com/music-api.');
  }
  return value;
}

export function createMusicApi(settings: ApiSettings, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const base = String(settings.url ?? '').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();

  const unreachable = () => new MusicApiError(`Cannot reach ${host}. Check the address and your internet connection.`);
  const stopped = () => new MusicApiError('stopped.');
  const notTheApi = () => new MusicApiError(`${host} does not answer like the music API. Check the cloud address in Settings.`);

  /** An answer that is not a success (the server's own sentence when it sent one). */
  function answerError(status: number, body: unknown): MusicApiError {
    if (status === 401) return new MusicApiError('Wrong key. Check the cloud key in Settings.', status);
    const data = body as { error?: unknown; song?: ApiSong } | null | undefined;
    if (data && typeof data.error === 'string') return new MusicApiError(data.error, status, data.song ?? null);
    if (status === 404) return new MusicApiError(`No music API at ${base}. Check the cloud address in Settings.`, status);
    return new MusicApiError(`The server answered with an error (${status}).`, status);
  }

  /** Reads an answer: the JSON (null for 204), or throws a MusicApiError. */
  function readAnswer(status: number, text: string): unknown {
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (status < 200 || status >= 300) throw answerError(status, data);
    if (status === 204) return null;
    if (data === undefined || data === null) throw notTheApi();
    return data;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { 'X-API-Key': settings.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw (e as Error)?.name === 'TimeoutError' ? new MusicApiError(`${host} did not answer in time.`) : unreachable();
    }
    return readAnswer(res.status, await res.text().catch(() => '')) as T;
  }

  function form(file: Blob, name: string, fields: UploadFields): FormData {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') data.append(k, String(v));
    }
    data.append('file', file, name);
    return data;
  }

  /** In the app: XMLHttpRequest, the only way to see upload progress. */
  function uploadXhr(data: FormData, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<ApiSong> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/songs`);
      xhr.setRequestHeader('X-API-Key', settings.key);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        try {
          resolve(readAnswer(xhr.status, xhr.responseText) as ApiSong);
        } catch (e) {
          reject(e);
        }
      };
      xhr.onerror = () => reject(unreachable());
      xhr.onabort = () => reject(stopped());
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(data);
    });
  }

  return {
    status: () => call<{ storedBytes: number; storageLimitBytes: number; songs: number }>('GET', '/status'),
    songs: () => call<{ songs: ApiSong[]; synced: { added: number; removed: number } }>('GET', '/songs'),
    editSong: (id: number, changes: Partial<Pick<ApiSong, 'title' | 'artist' | 'genre' | 'album' | 'duration' | 'isrc'>>) =>
      call<ApiSong>('PATCH', `/songs/${id}`, changes),
    /** False when the song was not on the cloud (anymore). */
    async deleteSong(id: number): Promise<boolean> {
      try {
        await call('DELETE', `/songs/${id}`);
        return true;
      } catch (e) {
        if ((e as MusicApiError).status === 404) return false;
        throw e;
      }
    },
    /** For <audio> and downloads, which cannot send the key header. */
    fileUrl: (id: number) => `${base}/songs/${id}/file?key=${encodeURIComponent(settings.key)}`,

    /** Sends one song. `onProgress(sent, total)` in bytes; a 409 carries the song already there. */
    async upload(
      file: Blob,
      name: string,
      fields: UploadFields,
      opts: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
    ): Promise<ApiSong> {
      if (opts.signal?.aborted) throw stopped();
      const data = form(file, name, fields);
      const onProgress = opts.onProgress ?? (() => {});
      if (typeof XMLHttpRequest !== 'undefined' && !options.fetch) return uploadXhr(data, onProgress, opts.signal);
      onProgress(0, file.size);
      let res: Response;
      try {
        res = await doFetch(`${base}/songs`, { method: 'POST', headers: { 'X-API-Key': settings.key }, body: data, signal: opts.signal });
      } catch (e) {
        throw (e as Error)?.name === 'AbortError' ? stopped() : unreachable();
      }
      const song = readAnswer(res.status, await res.text().catch(() => '')) as ApiSong;
      onProgress(file.size, file.size);
      return song;
    },

    playlists: async () => (await call<{ playlists: ApiPlaylist[] }>('GET', '/playlists')).playlists,
    createPlaylist: (playlist: { name: string; owner?: string; songs: ApiPlaylistRef[] }) => call<ApiPlaylist>('POST', '/playlists', playlist),
    updatePlaylist: (id: string, changes: { name?: string; songs?: ApiPlaylistRef[] }) => call<ApiPlaylist>('PATCH', `/playlists/${id}`, changes),
    deletePlaylist: async (id: string) => {
      await call('DELETE', `/playlists/${id}`);
    },
  };
}

export type MusicApi = ReturnType<typeof createMusicApi>;
