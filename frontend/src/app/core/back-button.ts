// The phone's Back button (Android app only): like other apps, it closes an open menu, then goes back a page, and on
// the home page sends the app to the background instead of closing it (closing it would stop the music).
import { Capacitor } from '@capacitor/core';
import type { NavService, View } from './nav.service';

export type BackStep = 'close-dialog' | 'back' | 'minimize';

export function backStep(state: { dialogOpen: boolean; page: View['page'] }): BackStep {
  if (state.dialogOpen) return 'close-dialog';
  return state.page === 'home' ? 'minimize' : 'back';
}

/** Takes over the Back button in the Android app; does nothing elsewhere (the browser has its own Back). */
export async function handleBackButton(nav: NavService): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', () => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    switch (backStep({ dialogOpen: Boolean(dialog), page: nav.view().page })) {
      case 'close-dialog':
        dialog?.close();
        break;
      case 'back':
        nav.back();
        break;
      case 'minimize':
        void App.minimizeApp();
        break;
    }
  });
}
