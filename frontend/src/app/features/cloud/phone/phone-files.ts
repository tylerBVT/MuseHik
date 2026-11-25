// Song files on the phone. Downloads go into the app's own storage through the File Transfer plugin (native, so a big
// song never sits in the page's memory), first as "<name>.part", renamed once complete and checked against the size
// the cloud gave, so a cut download is never taken for a song; then they move into the Music folder
// (MusicFolderPlugin.java), where a computer sees them over the cable and where songs copied by cable are found.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { parseBlob } from 'music-metadata';
import type { MusicFile } from './phone-cloud';
import type { SongTags } from './phone-jobs';

type MusicFolderPlugin = {
  list(): Promise<{ songs: MusicFile[] }>;
  save(options: { from: string; name: string }): Promise<{ id: number; uri: string }>;
  delete(options: { id: number }): Promise<void>;
};
const MusicFolder = registerPlugin<MusicFolderPlugin>('MusicFolder');

export const listMusic = async () => (await MusicFolder.list()).songs;
export const saveToMusic = (from: string, name: string) => MusicFolder.save({ from, name });
export const deleteMusic = (id: number) => MusicFolder.delete({ id });

const DIR = 'songs';

/** Downloads `url` into the app's storage as `local`; returns the file's URI. */
export async function downloadSong(url: string, local: string, expectedSize: number): Promise<string> {
  await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true }).catch(() => {
    /* already there */
  });
  const part = `${DIR}/${local}.part`;
  const target = `${DIR}/${local}`;
  const { uri: partUri } = await Filesystem.getUri({ path: part, directory: Directory.Data });
  try {
    await FileTransfer.downloadFile({ url, path: partUri });
    const { size } = await Filesystem.stat({ path: part, directory: Directory.Data });
    if (expectedSize && size !== expectedSize) throw new Error(`The download stopped early (${size} of ${expectedSize} bytes). Try again.`);
    await Filesystem.rename({ from: part, to: target, directory: Directory.Data, toDirectory: Directory.Data });
  } catch (e) {
    await Filesystem.deleteFile({ path: part, directory: Directory.Data }).catch(() => {});
    throw new Error(downloadMessage(e));
  }
  return (await Filesystem.getUri({ path: target, directory: Directory.Data })).uri;
}

function downloadMessage(e: unknown): string {
  const error = e as { message?: string; httpStatus?: number; code?: string };
  if (error.httpStatus === 401) return 'Wrong key. Check the cloud key in Settings.';
  if (error.httpStatus === 404) return 'This song is not on the cloud anymore.';
  if (error.httpStatus) return `The cloud answered with an error (${error.httpStatus}).`;
  if (/stopped early/.test(error.message ?? '')) return error.message!;
  return 'Cannot reach the cloud. Check your internet connection.';
}

export async function deleteSongFile(local: string): Promise<void> {
  await Filesystem.deleteFile({ path: `${DIR}/${local}`, directory: Directory.Data }).catch(() => {
    /* already gone */
  });
}

/** What the player plays: Android's player opens Music folder songs (content://) itself. */
export const playable = (uri: string) => (uri.startsWith('content://') ? uri : Capacitor.convertFileSrc(uri));

/** The tags of a file picked on the phone (title, artist, album, length, ISRC), like the laptops read before uploading. */
export async function readTags(file: File): Promise<SongTags> {
  const { common, format } = await parseBlob(file, { duration: true, skipCovers: true });
  const base = file.name.replace(/\.[^.]+$/, '');
  const dash = base.indexOf(' - ');
  return {
    title: common.title?.trim() || (dash > 0 ? base.slice(dash + 3) : base),
    artist: common.artist?.trim() || (dash > 0 ? base.slice(0, dash) : ''),
    album: common.album?.trim() ?? '',
    duration: Math.round((format.duration ?? 0) * 100) / 100,
    isrc: common.isrc?.[0] ?? null,
  };
}
