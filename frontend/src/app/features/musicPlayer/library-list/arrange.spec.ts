import { Track } from '../../../core/api';
import { arrange, formatDay, genresOf } from './arrange';

const now = new Date('2026-11-23T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const t = (id: number, title: string, artist: string, addedAt: string | null): Track => ({
  id, title, artist, album: '', duration: 100, addedAt,
});

const tracks = [
  t(1, 'banana', 'Zed', daysAgo(40)),
  t(2, 'Apple', 'mia', daysAgo(2)),
  t(3, 'cherry', 'Ab', null),
  t(4, 'Date', 'Ab', daysAgo(400)),
];
const titles = (list: Track[]) => list.map((x) => x.title);

describe('arrange', () => {
  it('keeps the given order by default', () => {
    expect(titles(arrange(tracks, { query: '', sort: 'default', since: 'any', now }))).toEqual(['banana', 'Apple', 'cherry', 'Date']);
  });

  it('sorts by title and by artist, ignoring case', () => {
    expect(titles(arrange(tracks, { query: '', sort: 'title', since: 'any', now }))).toEqual(['Apple', 'banana', 'cherry', 'Date']);
    expect(titles(arrange(tracks, { query: '', sort: 'artist', since: 'any', now }))).toEqual(['cherry', 'Date', 'Apple', 'banana']);
  });

  it('sorts by date both ways, songs without a date last', () => {
    expect(titles(arrange(tracks, { query: '', sort: 'newest', since: 'any', now }))).toEqual(['Apple', 'banana', 'Date', 'cherry']);
    expect(titles(arrange(tracks, { query: '', sort: 'oldest', since: 'any', now }))).toEqual(['Date', 'banana', 'Apple', 'cherry']);
  });

  it('filters by period; songs without a date only show for "any time"', () => {
    expect(titles(arrange(tracks, { query: '', sort: 'default', since: '7', now }))).toEqual(['Apple']);
    expect(titles(arrange(tracks, { query: '', sort: 'default', since: '30', now }))).toEqual(['Apple']);
    expect(titles(arrange(tracks, { query: '', sort: 'default', since: '365', now }))).toEqual(['banana', 'Apple']);
  });

  it('combines the text search with the period and the sort', () => {
    const more = [...tracks, t(5, 'Apple pie', 'Zed', daysAgo(1))];
    expect(titles(arrange(more, { query: 'apple', sort: 'newest', since: '7', now }))).toEqual(['Apple pie', 'Apple']);
    expect(titles(arrange(more, { query: 'zed', sort: 'title', since: 'any', now }))).toEqual(['Apple pie', 'banana']);
  });

  it('never changes the list it is given', () => {
    const copy = [...tracks];
    arrange(tracks, { query: '', sort: 'title', since: 'any', now });
    expect(tracks).toEqual(copy);
  });
});

describe('formatDay', () => {
  it('writes a short day, or nothing when unknown', () => {
    expect(formatDay('2026-11-21T10:00:00Z')).toMatch(/21/);
    expect(formatDay('2026-11-21T10:00:00Z')).toMatch(/2026/);
    expect(formatDay(null)).toBe('');
    expect(formatDay('not a date')).toBe('');
  });
});

describe('genre', () => {
  const tagged = [
    { ...t(1, 'One', 'A', null), genre: 'Rap' },
    { ...t(2, 'Two', 'B', null), genre: 'rap' },
    { ...t(3, 'Three', 'C', null), genre: 'Jazz' },
    t(4, 'Four', 'D', null),
  ];

  it('keeps only the songs of the chosen genre, ignoring case', () => {
    expect(titles(arrange(tagged, { query: '', sort: 'default', since: 'any', genre: 'Rap', now }))).toEqual(['One', 'Two']);
  });

  it('shows everything when no genre is chosen', () => {
    expect(arrange(tagged, { query: '', sort: 'default', since: 'any', genre: '', now }).length).toBe(4);
  });

  it('searches the genre too', () => {
    expect(titles(arrange(tagged, { query: 'jazz', sort: 'default', since: 'any', now }))).toEqual(['Three']);
  });

  it('lists each genre once, sorted, without empty ones', () => {
    expect(genresOf(tagged)).toEqual(['Jazz', 'Rap']);
  });
});
