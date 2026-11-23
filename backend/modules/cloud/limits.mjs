// The cloud's budget: total storage (her hosting has no traffic limit, so traffic is not counted). Pure functions, no I/O.
export const GB = 1e9;
export const WARN_AT = 0.8;

/** A refusal because a budget would be exceeded (not a connection problem). */
export class LimitError extends Error {
  code = 'LIMIT';
}

/** What the storage bar shows: storage against its cap. */
export function usageSummary({ settings, storedBytes = 0 }) {
  const storageLimitBytes = settings.storageLimitGB * GB;
  return {
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
