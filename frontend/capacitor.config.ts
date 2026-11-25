import type { CapacitorConfig } from '@capacitor/cli';

/** The Android app: the same Angular build as the Windows app, packaged by Capacitor (`npm run android`). */
const config: CapacitorConfig = {
  appId: 'com.musehik.app',
  appName: 'MuseHik',
  webDir: 'dist/musehik-frontend/browser',
};

export default config;
