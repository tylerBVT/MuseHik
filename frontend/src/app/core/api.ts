/**
 * Base URL of the local MuseHik server (backend). When the server itself serves the app (MuseHik.bat), the API is on
 * the same address; under `ng serve` (port 4200) it is the server on port 3000.
 */
export const API = globalThis.location?.port === '4200' ? 'http://127.0.0.1:3000/api' : `${globalThis.location?.origin ?? 'http://127.0.0.1:3000'}/api`;

export type Track = {
  id: number;
  title: string;
  artist: string;
  album: string;
  /** Length in seconds. */
  duration: number;
  /** File size in bytes (library songs). */
  size?: number;
  /** Cloud songs only: where to stream, show the cover and fetch in advance (library songs use their id). */
  stream?: string;
  cover?: string;
  prefetch?: string;
};

export const streamUrl = (track: Track) => track.stream ?? `${API}/library/${track.id}/stream`;
export const coverUrl = (track: Track) => track.cover ?? `${API}/library/${track.id}/cover`;

/** 3:07 style time. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}
