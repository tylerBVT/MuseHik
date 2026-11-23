import { Track } from '../../../core/api';

export type SortBy = 'default' | 'title' | 'artist' | 'newest' | 'oldest';
/** How far back to show songs, in days ('any' = everything, songs without a date included). */
export type Since = 'any' | '7' | '30' | '365';

export const SORTS: { value: SortBy; label: string }[] = [
  { value: 'default', label: 'Default order' },
  { value: 'title', label: 'Title A-Z' },
  { value: 'artist', label: 'Artist A-Z' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];
export const PERIODS: { value: Since; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '365', label: 'Last 12 months' },
];

const DAY_MS = 86_400_000;
const byText = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
const time = (track: Track) => {
  const ms = track.addedAt ? Date.parse(track.addedAt) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
/** Dated songs by date (`direction` 1 = oldest first), undated ones last. */
const byDate = (direction: 1 | -1) => (a: Track, b: Track) => {
  const ta = time(a);
  const tb = time(b);
  if (ta === null || tb === null) return ta === null ? (tb === null ? 0 : 1) : -1;
  return (ta - tb) * direction;
};

/** Each genre present once, sorted (the Genre menu). Same genre in another case counts once. */
export function genresOf(tracks: Track[]): string[] {
  const seen = new Map<string, string>();
  for (const track of tracks) {
    const genre = track.genre?.trim();
    if (genre && !seen.has(genre.toLowerCase())) seen.set(genre.toLowerCase(), genre);
  }
  return [...seen.values()].sort(byText);
}

/**
 * The songs to show: text search (every word in title, artist, album or genre), then the genre ('' = any) and the
 * period, then the sort.
 */
export function arrange(
  tracks: Track[],
  {
    query,
    sort,
    since,
    genre = '',
    now = new Date(),
  }: { query: string; sort: SortBy; since: Since; genre?: string; now?: Date },
): Track[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const from = since === 'any' ? null : now.getTime() - Number(since) * DAY_MS;
  const wantedGenre = genre.trim().toLowerCase();
  const shown = tracks.filter((track) => {
    if (wantedGenre && (track.genre ?? '').trim().toLowerCase() !== wantedGenre) return false;
    if (from !== null) {
      const at = time(track);
      if (at === null || at < from) return false;
    }
    if (!words.length) return true;
    const text = `${track.title} ${track.artist} ${track.album} ${track.genre ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  switch (sort) {
    case 'title':
      return shown.sort((a, b) => byText(a.title, b.title));
    case 'artist':
      return shown.sort((a, b) => byText(a.artist, b.artist) || byText(a.title, b.title));
    case 'newest':
      return shown.sort(byDate(-1));
    case 'oldest':
      return shown.sort(byDate(1));
    default:
      return shown;
  }
}

/** "21 Nov 2026", or '' when the date is unknown. */
export function formatDay(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
