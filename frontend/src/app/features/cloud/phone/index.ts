// The phone's cloud, created once when running as the Android app (null on the laptops). Its device side (files,
// tags) is loaded only when first used, so the laptops never download it.
import { Capacitor } from '@capacitor/core';
import { usePhoneTracks } from '../../../core/api';
import { isPhone } from '../../../core/platform';
import { PhoneCloud } from './phone-cloud';
import { PhoneStore } from './phone-store';

const files = () => import('./phone-files');

function create(): PhoneCloud {
  let storage: Storage;
  try {
    storage = localStorage;
  } catch {
    storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  }
  const cloud = new PhoneCloud(new PhoneStore(storage), {
    downloadSong: async (url, local, size) => (await files()).downloadSong(url, local, size),
    deleteSongFile: async (local) => (await files()).deleteSongFile(local),
    playable: (uri) => (uri.startsWith('content://') ? uri : Capacitor.convertFileSrc(uri)),
    readTags: async (file) => (await files()).readTags(file),
    listMusic: async () => (await files()).listMusic(),
    saveToMusic: async (from, name) => (await files()).saveToMusic(from, name),
    deleteMusic: async (id) => (await files()).deleteMusic(id),
  });
  usePhoneTracks((song) => cloud.toTrack(song));
  return cloud;
}

export const phoneCloud: PhoneCloud | null = isPhone ? create() : null;
