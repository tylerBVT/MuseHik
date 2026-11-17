// Pure helpers shared by all services (no I/O, so they can be unit-tested).

export const safeName = s =>
  String(s || 'Untitled').normalize('NFKC').replace(/[\x00-\x1f/\\:*?"<>|%]/g, '_')
    .replace(/^\.+/, '').replace(/[ .]+$/, '').slice(0, 100) || 'Untitled';

const words = s =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];

/** Higher is better. Rewards matching title/artist words and similar duration. */
export function scoreCandidate(track, cand) {
  const have = new Set([...words(cand.title || ''), ...words(cand.uploader || cand.channel || '')]);
  let score = 0;
  for (const w of words(track.title)) if (have.has(w)) score += 2;
  for (const w of words(track.artist)) if (have.has(w)) score += 1;
  if (track.duration && cand.duration) {
    const diff = Math.abs(track.duration - cand.duration);
    score += diff <= 3 ? 6 : diff <= 8 ? 3 : diff <= 20 ? 0 : -6;
  }
  if (/ - topic$/i.test(cand.uploader || cand.channel || '')) score += 2; // official audio uploads
  const unwanted = /\b(live|cover|karaoke|remix|reaction|instrumental)\b/i;
  if (unwanted.test(cand.title || '') && !unwanted.test(track.title)) score -= 4;
  return score;
}

export function bestMatch(track, candidates) {
  return [...candidates].sort((a, b) => scoreCandidate(track, b) - scoreCandidate(track, a))[0];
}

/** Flat library file name (without extension): "Artist - Title". */
export const fileBase = (artist, title) => safeName(artist ? `${artist} - ${title}` : title);

// "feat." credits are not part of a song's identity; version words (remix, live, ...) are kept on purpose.
const stripFeat = s => String(s)
  .replace(/[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, '');
const primaryArtist = a => String(a).split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0];

/** Identity key used to recognise "the same song" across platforms and files. */
export const trackKey = (artist, title) =>
  `${words(primaryArtist(artist)).join(' ')}|${words(stripFeat(title)).join(' ')}`;

/** True when two durations (seconds) are compatible; unknown durations never block a match. */
export const sameLength = (a, b, tolerance = 6) => !a || !b || Math.abs(a - b) <= tolerance;
