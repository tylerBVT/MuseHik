// Registry of platform services. To add a platform, create a file exporting { id, label, parse, resolve }
// and add it to this list.
import { youtube } from './youtube.mjs';
import { spotify } from './spotify.mjs';
import { deezer } from './deezer.mjs';

export const services = [youtube, spotify, deezer];

/** Finds which service handles a pasted link. Returns { service, ref }. Throws a user-friendly Error. */
export function detect(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('Paste a full link starting with https://'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Unsupported link.');
  for (const service of services) {
    const ref = service.parse(u);
    if (ref) return { service, ref };
  }
  throw new Error(`Unsupported link. Supported: ${services.map(s => s.label).join(', ')}.`);
}
