// The storage bar. The cap itself lives on the server (config.php) and the server refuses uploads past it;
// this only turns its numbers into what the page shows. Pure, no I/O.
export const GB = 1e9;
export const WARN_AT = 0.8;

/** What the storage bar shows: storage against the cap the server reports. */
export function usageSummary({ storedBytes = 0, storageLimitBytes = 0 }) {
  return {
    storedBytes,
    storageLimitBytes,
    percent: storageLimitBytes ? Math.min(100, Math.round((storedBytes / storageLimitBytes) * 1000) / 10) : 100,
    warning: storedBytes >= storageLimitBytes * WARN_AT,
  };
}
