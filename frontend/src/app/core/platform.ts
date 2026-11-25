import { Capacitor } from '@capacitor/core';
import { isDevMode } from '@angular/core';

/**
 * Running as the Android app (Capacitor), not in the Windows app or a browser. In development, the phone's screens
 * can be tried in a browser: localStorage "musehik.phoneMode" = "1" (saving songs on the phone needs the real app).
 */
export const isPhone =
  Capacitor.isNativePlatform() ||
  (isDevMode() && (() => {
    try {
      return globalThis.localStorage?.getItem('musehik.phoneMode') === '1';
    } catch {
      return false;
    }
  })());

/**
 * The phone has no MuseHik server: no library on disk, no downloader, no instrumental separator. Its cloud screens
 * talk to the music API directly (features/cloud/phone/). Everything that needs the server is switched off with this
 * flag, so the phone shows only what works there.
 */
export const hasServer = !isPhone;

/** "phone" or "laptop", for sentences like "Songs on this phone still play". */
export const deviceName = isPhone ? 'phone' : 'laptop';
