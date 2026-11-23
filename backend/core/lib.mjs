// Pure helpers shared by all services (no I/O, so they can be unit-tested).

/** File extensions the library and the cloud treat as songs. */
export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.opus', '.ogg', '.flac', '.wav']);

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
  return rankMatches(track, candidates, 1)[0];
}

/**
 * Candidates best-first, keeping only plausible ones (some title match, length not far off), at most `max`.
 * The best candidate is always kept, so a search never comes back empty-handed when it found something.
 */
export function rankMatches(track, candidates, max = 3) {
  const scored = candidates.map(c => ({ c, score: scoreCandidate(track, c) })).sort((a, b) => b.score - a.score);
  const plausible = scored.filter(({ c, score }, i) =>
    i === 0 || (score >= 4 && (!track.duration || !c.duration || Math.abs(track.duration - c.duration) <= 20)));
  return plausible.slice(0, max).map(({ c }) => c);
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

/** Same song: same ISRC, or the same cleaned artist + title with a compatible length. */
export function sameIdentity(a, b) {
  if (a.isrc && b.isrc && String(a.isrc).toLowerCase() === String(b.isrc).toLowerCase()) return true;
  const keyOf = s => s.key || trackKey(s.artist || '', s.title || '');
  return keyOf(a) === keyOf(b) && sameLength(a.duration, b.duration);
}

// ---- Loose identity: the same song uploaded differently ("PLK - Décembre | A COLORS SHOW" by COLORS,
// "Décembre - A COLORS SHOW" by "PLK, COLORS", "Décembre" by PLK). Only used together with a matching duration.
const NOISE = String.raw`official|officiel+e?|music|video|vid[eé]o|clip|audio|lyrics?|paroles|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|colors\s+show`;
const noiseOnly = new RegExp(String.raw`^(?:\s|a\b|the\b|(?:${NOISE})\b)+$`, 'i');

/** Removes upload decorations: "(Official Video)", "[Clip Officiel]", "| A COLORS SHOW", "- Lyrics". */
export function cleanUploadTitle(title) {
  let t = String(title || '').split(/\s[|｜]\s/)[0];
  t = t.replace(/[(\[]([^)\]]*)[)\]]/g, (all, inner) => (noiseOnly.test(inner) ? '' : all));
  const parts = t.split(/\s[-–—]\s/);
  while (parts.length > 1 && noiseOnly.test(parts.at(-1))) parts.pop();
  return parts.join(' - ').trim();
}

const artistNames = a => String(a || '')
  .replace(/\s-\sTopic$/i, '').replace(/vevo$/i, '')
  .split(/,|&|\bx\b|\bet\b|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b/i)
  .map(s => words(s).join(' ')).filter(Boolean);

/** All plausible (artists, title) readings of an upload, e.g. "PLK - Décembre" by COLORS also reads as PLK / Décembre. */
export function readings(artist, title) {
  const core = cleanUploadTitle(title);
  const out = [{ artists: artistNames(artist), title: words(stripFeat(core)).join(' ') }];
  const m = core.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (m) out.push({ artists: artistNames(m[1]), title: words(stripFeat(m[2])).join(' ') });
  return out.filter(r => r.title);
}

/**
 * True when two tracks are very likely the same recording: a reading with the same title, at least one
 * shared artist, and durations within `tolerance` seconds (both durations must be known).
 */
export function sameSong(a, b, tolerance = 4) {
  if (!a.duration || !b.duration || Math.abs(a.duration - b.duration) > tolerance) return false;
  const rb = readings(b.artist, b.title);
  return readings(a.artist, a.title).some(x => rb.some(y =>
    x.title === y.title && x.artists.some(name => y.artists.includes(name))));
}
