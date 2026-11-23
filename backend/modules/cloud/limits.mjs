// The cloud's budget: total storage. Traffic is only counted per calendar month and shown (her hosting has no
// traffic limit). Pure functions, no I/O.
export const GB = 1e9;
export const WARN_AT = 0.8;

/** "2026-11" for any day of November 2026 (local time). */
export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/** A refusal because a budget would be exceeded (not a connection problem). */
export class LimitError extends Error {
  code = 'LIMIT';
}

/** What the usage bar shows: storage against its cap, plus this month's traffic. `usage` = the cloud's usage.json. */
export function usageSummary({ usage, settings, storedBytes = 0, date = new Date() }) {
  const month = monthKey(date);
  const storageLimitBytes = settings.storageLimitGB * GB;
  return {
    month,
    usedBytes: usage?.months?.[month]?.bytes ?? 0,
    storedBytes,
    storageLimitBytes,
    percent: storageLimitBytes ? Math.min(100, Math.round((storedBytes / storageLimitBytes) * 1000) / 10) : 100,
    warning: storedBytes >= storageLimitBytes * WARN_AT,
  };
}

/** Throws a LimitError when storing `bytes` more would pass the storage cap. */
export function checkStorage({ storedBytes, storageLimitBytes, bytes }) {
  if (storedBytes + bytes > storageLimitBytes) {
    const free = Math.max(0, storageLimitBytes - storedBytes);
    throw new LimitError(`Not enough cloud storage: ${(free / GB).toFixed(2)} GB free of ${storageLimitBytes / GB} GB.`);
  }
}
