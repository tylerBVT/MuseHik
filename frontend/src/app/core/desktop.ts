/** What the update check reports (Settings > About MuseHik). */
export type UpdateStatus = {
  status: 'latest' | 'downloading' | 'ready' | 'error';
  version?: string;
  message?: string;
};

/** Given by the desktop app (desktop/preload.cjs). Missing when MuseHik runs in a browser. */
export interface MuseHikDesktop {
  /** The native Windows "Select folder" window. */
  pickFolder(): Promise<string | null>;
  /** Called once a new version has been downloaded and is ready to install. */
  onUpdateReady(cb: (version: string) => void): void;
  /** Closes MuseHik, installs the downloaded version and starts it again. */
  restartToUpdate(): void;
  checkForUpdates(): Promise<UpdateStatus>;
}

export const desktop: MuseHikDesktop | undefined = (globalThis as { musehik?: MuseHikDesktop }).musehik;
