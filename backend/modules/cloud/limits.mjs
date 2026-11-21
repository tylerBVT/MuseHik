// The cloud's two budgets: traffic per calendar month (to protect the other websites on the same hosting) and
// total storage. Pure functions, no I/O.
export const GB = 1e9;
export const WARN_AT = 0.8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/** "2026-11" for any day of November 2026 (local time). */
export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const limitMessage = (date = new Date()) =>
  `Cloud limit reached for ${MONTHS[date.getMonth()]}. It resets on 1 ${MONTHS[(date.getMonth() + 1) % 12]}.`;

/** A refusal because a budget would be exceeded (not a connection problem). */
export class LimitError extends Error {
  code = 'LIMIT';
}

/** What the usage bars show. `usage` is the content of the cloud's usage.json (or null). */
export function usageSummary({ usage, settings, storedBytes = 0, date = new Date() }) {
  const month = monthKey(date);
  const usedBytes = usage?.months?.[month]?.bytes ?? 0;
  const limitBytes = settings.monthlyLimitGB * GB;
  const reached = usedBytes >= limitBytes;
  return {
    month, usedBytes, limitBytes,
    percent: limitBytes ? Math.min(100, Math.round((usedBytes / limitBytes) * 1000) / 10) : 100,
    warning: usedBytes >= limitBytes * WARN_AT,
    reached,
    storedBytes,
    storageLimitBytes: settings.storageLimitGB * GB,
    message: reached ? limitMessage(date) : null,
  };
}

/** Throws a LimitError when moving `bytes` more would pass this month's traffic limit. */
export function checkTransfer({ usedBytes, limitBytes, bytes, date = new Date() }) {
  if (usedBytes + bytes > limitBytes) throw new LimitError(limitMessage(date));
}

/** Throws a LimitError when storing `bytes` more would pass the storage cap. */
export function checkStorage({ storedBytes, storageLimitBytes, bytes }) {
  if (storedBytes + bytes > storageLimitBytes) {
    const free = Math.max(0, storageLimitBytes - storedBytes);
    throw new LimitError(`Not enough cloud storage: ${(free / GB).toFixed(2)} GB free of ${storageLimitBytes / GB} GB.`);
  }
}
