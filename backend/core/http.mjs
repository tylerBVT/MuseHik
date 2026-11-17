// Small HTTP helpers shared by every module's routes.

/** Reads a small JSON request body (throws above `limit` characters). */
export async function readJson(req, limit = 200000) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > limit) throw new Error('Request too large.');
  }
  return JSON.parse(raw || '{}');
}
