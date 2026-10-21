// src/services/deviceAudioLibrary.ts
// Reads the Android shell's MediaStore view of the user's own music collection: whether the shell
// can serve it at all, whether the media-read permission is granted, the track list itself, and the
// same-origin URLs that stream a track and its album art.
//
// Nothing here copies audio. The shell answers /api/device-audio/* from the original content:// item,
// so a library of thousands of tracks costs no disk and no import wait - the bytes stay where they are
// and are streamed, with Range support, only when the track is played.

import type { LocalSong } from '../types';

/** The Android shell's JavaScript bridge, injected by `MainActivity` as `window.foliaAndroid`. */
interface FoliaAndroidBridge {
  /** Whether the media-read permission is already granted. Absent on older shells. */
  hasAudioPermission?: () => boolean;
  /** Shows the permission dialog; the answer arrives as a DOM event, not a return value. */
  requestAudioPermission?: () => void;
  getAppInfo?: () => string | null;
  setImmersiveMode?: (enabled: boolean) => void;
  setPlaybackSnapshot?: (snapshotJson: string) => void;
  /**
   * Which shell this is, when it is willing to say. The Android shell never answers; the HarmonyOS
   * one answers `harmony`, and that answer is what wakes up the now-playing mirror in
   * `services/shellNowPlaying.ts`. See that module for why presence alone is not trusted.
   */
  getShellKind?: () => string;
  openBatteryOptimizationSettings?: () => void;
  openAppDetailsSettings?: () => void;
}

declare global {
  interface Window {
    foliaAndroid?: FoliaAndroidBridge;
  }
}

/** DOM event the shell dispatches with the permission dialog's outcome. */
export const DEVICE_AUDIO_PERMISSION_EVENT = 'folia-android-audio-permission';

/**
 * The synthetic folder every device-backed song is filed under. It is a real local-library folder as
 * far as the rest of the app is concerned: the existing folder / album / artist grouping, lyric
 * matching and playlist code all work on these songs without knowing where they came from.
 */
export const DEVICE_AUDIO_ROOT_FOLDER = '手机音乐';

/**
 * Root segment of a device song's `filePath`. ASCII on purpose: `filePath` doubles as a lookup key
 * and as the root name the folder-rescan code derives from it, and that code compares roots against
 * persisted directory handles - which a device song never has, so those roots are skipped.
 */
export const DEVICE_AUDIO_ROOT_PATH = 'device-audio';

const DEVICE_AUDIO_BASE = '/api/device-audio';

export interface DeviceAudioTrack {
  /** MediaStore `_ID`. Stable for as long as the file is on the device, and the song's identity. */
  id: number;
  title: string;
  artist: string;
  album: string;
  albumId: number;
  durationMs: number;
  size: number;
  mimeType: string;
  fileName: string;
  /** Milliseconds since epoch, converted from MediaStore's DATE_ADDED seconds. */
  addedAt: number;
  relativePath?: string;
}

export type DeviceAudioPermission = 'granted' | 'denied' | 'unavailable';

export type DeviceAudioLibraryResult =
  | { status: 'granted'; tracks: DeviceAudioTrack[] }
  | { status: 'denied' }
  | { status: 'unavailable' };

/**
 * Whether this build can read the device's music collection at all. The bridge is the only honest
 * signal: the desktop build and a deployed web build have no shell, and probing the route instead
 * would report "supported" exactly when the SPA fallback answered with an HTML document.
 */
export const isDeviceAudioLibrarySupported = (): boolean => (
  typeof window !== 'undefined'
  && typeof window.foliaAndroid?.hasAudioPermission === 'function'
);

/** The stream URL for one track. The player treats it as an ordinary media URL with byte ranges. */
export const buildDeviceAudioStreamUrl = (deviceAudioId: number): string => (
  `${DEVICE_AUDIO_BASE}/stream?id=${encodeURIComponent(String(deviceAudioId))}`
);

/** The album-art URL for one album, or null when there is no album to look up. */
export const buildDeviceAudioCoverUrl = (albumId: number): string | null => (
  Number.isFinite(albumId) && albumId > 0
    ? `${DEVICE_AUDIO_BASE}/cover?albumId=${encodeURIComponent(String(albumId))}`
    : null
);

/**
 * A device song is recognised by this marker alone; no path or naming convention is involved.
 *
 * These two predicates live here, in the module that imports nothing from the local library, because
 * the local music service needs them and the sync service needs the local music service - putting
 * them in the sync service would close an import cycle.
 */
export const isDeviceAudioSong = (song: LocalSong): boolean => (
  typeof song.deviceAudioId === 'number' && Number.isFinite(song.deviceAudioId)
);

/** Stable id for a device-backed song, derived from the MediaStore id so a re-sync matches it. */
export const deviceAudioSongId = (deviceAudioId: number): string => `device_${deviceAudioId}`;

/** Whether the permission is granted right now, asked of the shell rather than remembered. */
export const hasDeviceAudioPermission = (): boolean => {
  try {
    return Boolean(window.foliaAndroid?.hasAudioPermission?.());
  } catch {
    return false;
  }
};

const waitForPermissionAnswer = (timeoutMs: number): Promise<boolean> => (
  new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (granted: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(DEVICE_AUDIO_PERMISSION_EVENT, handleAnswer);
      window.clearTimeout(timer);
      resolve(granted);
    };
    const handleAnswer = (event: Event) => {
      finish(Boolean((event as CustomEvent<{ granted?: boolean; }>).detail?.granted));
    };
    // A dialog that is never answered (the app is backgrounded, the activity is recreated) would
    // otherwise leave the caller pending forever. The timeout only ends the wait; it never claims
    // the permission was refused, because the caller re-asks the shell for the real answer.
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener(DEVICE_AUDIO_PERMISSION_EVENT, handleAnswer);
  })
);

/**
 * Asks for the media-read permission, resolving with the truth rather than with the dialog's
 * outcome. The dialog may never be shown at all (a permanently denied permission, a vendor ROM that
 * suppresses it), and in that case the shell's own check is the only thing that knows.
 */
export const requestDeviceAudioPermission = async (): Promise<boolean> => {
  if (!isDeviceAudioLibrarySupported()) return false;
  if (hasDeviceAudioPermission()) return true;
  try {
    window.foliaAndroid?.requestAudioPermission?.();
  } catch (error) {
    console.warn('[DeviceAudio] Permission request failed:', error);
    return false;
  }
  const granted = await waitForPermissionAnswer(180_000);
  // The event can be lost (the page reloads mid-dialog), so the shell is asked either way.
  return granted || hasDeviceAudioPermission();
};

const readTrack = (value: unknown): DeviceAudioTrack | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  if (!Number.isFinite(id) || id < 0) return null;
  const text = (key: string): string => (typeof raw[key] === 'string' ? raw[key] as string : '');
  const number = (key: string): number => {
    const parsed = Number(raw[key]);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    id,
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    albumId: number('albumId'),
    durationMs: number('durationMs'),
    size: number('size'),
    mimeType: text('mimeType'),
    fileName: text('fileName'),
    addedAt: number('addedAt') || Date.now(),
    relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : undefined,
  };
};

/**
 * The device's music collection as the shell sees it. A denied permission is reported as its own
 * status rather than as an error, because the two lead to different behaviour: denied means "ask the
 * user once", unavailable means "stop offering this".
 */
export const fetchDeviceAudioLibrary = async (): Promise<DeviceAudioLibraryResult> => {
  if (!isDeviceAudioLibrarySupported()) return { status: 'unavailable' };
  try {
    const response = await fetch(DEVICE_AUDIO_BASE, { cache: 'no-store' });
    if (response.status === 403) return { status: 'denied' };
    if (!response.ok) {
      console.warn(`[DeviceAudio] Library request failed with ${response.status}`);
      return { status: 'unavailable' };
    }
    const payload = await response.json() as { permission?: string; tracks?: unknown[]; };
    if (payload.permission !== 'granted') {
      return payload.permission === 'denied' ? { status: 'denied' } : { status: 'unavailable' };
    }
    const tracks = (Array.isArray(payload.tracks) ? payload.tracks : [])
      .map(readTrack)
      .filter((track): track is DeviceAudioTrack => track !== null);
    return { status: 'granted', tracks };
  } catch (error) {
    console.warn('[DeviceAudio] Library request threw:', error);
    return { status: 'unavailable' };
  }
};
