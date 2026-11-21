// Turns raw yt-dlp / network errors into a plain-language explanation plus what to try next.
// The raw text is kept as `detail` so the app can still show it under "Technical details".
// `kind` drives what the downloader does next:
//   blocked     YouTube refuses this computer: stop the whole job, wait (retrying makes it worse)
//   unavailable this upload cannot be had (removed, DRM, region, age...): try another upload of the song
//   outdated    YouTube changed something yt-dlp does not handle yet: update yt-dlp, then retry
//   other       anything else (network, bad link, ...)

const RULES = [
  ['blocked', /Sign in to confirm you.?re not a bot|HTTP Error 429|Too Many Requests/i,
    'YouTube refused to send this video: it suspects this computer is a bot (too many requests from your internet connection). This is not about the song itself.',
    'Wait a while (often an hour) and try again. MuseHik pauses YouTube requests for 10 minutes after this happens.'],
  ['unavailable', /DRM protected/i,
    'This upload is DRM-protected: the rights holder locked it, so it cannot be downloaded.',
    'Try another link for the same song (another YouTube upload, or a Deezer/Spotify link).'],
  ['unavailable', /Sign in to confirm your age|age.restricted|inappropriate for some users/i,
    'This video is age-restricted, and YouTube only plays it for signed-in accounts.',
    'Try another upload of the same song.'],
  ['unavailable', /not (made )?available in your country|geo.?restrict|blocked it in your country/i,
    'This video is blocked in your country.',
    'Try another upload of the same song.'],
  ['unavailable', /Private video|members.only|Join this channel/i,
    'This video is private or for channel members only.',
    'Try another upload of the same song.'],
  ['unavailable', /Video unavailable|video is unavailable|has been removed|This video is no longer available|account associated with this video has been terminated/i,
    'This video no longer exists (removed or deleted).',
    'Try another upload of the same song.'],
  ['outdated', /Requested format is not available|Only images are available|Unable to extract|nsig extraction failed|Signature extraction failed|challenge solving failed|Please report this issue|HTTP Error 403/i,
    'YouTube answered but gave no usable audio: YouTube probably changed something and yt-dlp needs an update.',
    'MuseHik updates yt-dlp automatically and retries once. If it still fails, try again tomorrow (fixes usually come within days).'],
  ['other', /No YouTube match found/i,
    'No matching video was found on YouTube for this song.',
    'Paste a YouTube link of the song directly.'],
  ['other', /Timed out/i,
    'The download took too long and was stopped.',
    'Check your internet connection and try again.'],
  ['other', /getaddrinfo|ENOTFOUND|ECONNRESET|ECONNREFUSED|Unable to connect|Failed to resolve|network is unreachable|fetch failed/i,
    'Could not reach the website (network problem).',
    'Check your internet connection and try again.'],
  ['other', /ffmpeg|ffprobe|Postprocessing/i,
    'The audio was downloaded but converting it to MP3 failed.',
    'Check that the backend Python environment is installed (MuseHik.bat sets it up).'],
];

/**
 * The useful part of a tool's output: its ERROR/WARNING lines (yt-dlp), else the last lines; at most ~1500 characters.
 * Repeated lines are kept once.
 */
export function condense(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const flagged = lines.filter(l => /^(ERROR|WARNING)\b/.test(l));
  const kept = [...new Set(flagged.length ? flagged : lines.slice(-10))].join('\n');
  return kept.length > 1500 ? `...${kept.slice(-1500)}` : kept;
}

/** Returns { kind, error, hint, detail } for an Error thrown anywhere in a download. */
export function explain(e) {
  if (e?.explained) return e.explained; // already classified (e.g. the YouTube cooldown)
  const raw = condense(e?.detail || e?.message || e || 'Unknown error');
  // The final ERROR line decides first; the full output (with its warnings) only when that line says nothing known.
  for (const text of [String(e?.message || ''), raw]) {
    for (const [kind, pattern, error, hint] of RULES) {
      if (pattern.test(text)) return { kind, error, hint, detail: raw };
    }
  }
  // Our own messages (bad link, Deezer/Spotify not found...) are already readable.
  return { kind: 'other', error: e?.message || raw, hint: '', detail: raw === e?.message ? '' : raw };
}

/** An Error that carries a ready-made explanation. */
export function explainedError(explained) {
  const error = new Error(explained.error);
  error.explained = explained;
  return error;
}
