import { isBlob } from '../utils/blobGuards';

// src/services/localAudioBinaryStore.ts
// Persists imported audio bytes outside IndexedDB in OPFS, in the same validated <key>.bin + <key>.json
// layout as localCoverBinaryStore. It backs playback for songs that were imported through a plain file
// input (a picker File with no FileSystemFileHandle to re-read later); songs imported from a directory
// handle keep using their handle and never touch this store.

export type LocalAudioBinaryBackend = 'opfs';

/** A stored audio asset key: "local-audio:" + the song id + ":" + the sanitized file name. */
const AUDIO_KEY_PREFIX = 'local-audio:';
const AUDIO_KEY_PATTERN = /^local-audio:(local_[0-9]+_[0-9a-z]+|sha256:[0-9a-f]{64}):([^/\\:*?"<>|\u0000-\u001f]{1,120})$/;
// File.type is what the bytes are labelled with downstream: an empty or unknown label is kept as
// application/octet-stream rather than rejected, so an audio file whose MIME the browser did not
// guess still plays. The allowlist only decides what a descriptor may claim.
const ALLOWED_MIME_TYPES = new Set([
  'application/octet-stream',
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
]);
const OPFS_ROOT_DIRECTORY = 'folia-cache';
const OPFS_LOCAL_AUDIO_DIRECTORY = 'local-audio-assets';

export interface LocalAudioBinaryWriteResult {
  backend: LocalAudioBinaryBackend;
  mimeType: string;
  size: number;
}

interface LocalAudioFileDescriptor {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  updatedAt: number;
}

const getKeyFileNames = (key: string) => (
  isValidLocalAudioAssetKey(key) ? { data: `${key}.bin`, metadata: `${key}.json` } : null
);

const normalizeAudioMimeType = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return ALLOWED_MIME_TYPES.has(normalized) ? normalized : null;
};

/** Keeps the file name usable inside one OPFS entry name without losing how the track is displayed. */
const sanitizeAudioFileName = (fileName: string): string => (
  fileName
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120) || 'audio'
);

export const isValidLocalAudioAssetKey = (value: unknown): value is string => (
  typeof value === 'string' && AUDIO_KEY_PATTERN.test(value)
);

/**
 * The store key for one imported song. Self-describing on purpose: the song id makes it lookup-able
 * from a LocalSong record alone, and the trailing file name keeps the persisted entry readable and
 * lets the file be rebuilt with a sensible name and MIME type when the database record is gone.
 */
export const buildLocalAudioAssetKey = (songId: string, fileName: string): string | null => {
  const key = `${AUDIO_KEY_PREFIX}${songId}:${sanitizeAudioFileName(fileName)}`;
  return isValidLocalAudioAssetKey(key) ? key : null;
};

/** The MIME type to persist for these bytes: the blob's own label, else a neutral binary label. */
export const resolveLocalAudioMimeType = (value: unknown): string | null => (
  isBlob(value) ? (normalizeAudioMimeType(value.type) ?? 'application/octet-stream') : null
);

const hasElectronBridge = (): boolean => (
  typeof window !== 'undefined' && typeof window.electron !== 'undefined'
);

export const isLocalAudioWebRuntimeSupported = (): boolean => {
  if (typeof window === 'undefined') return false;
  // The Electron build plays local files through its own bridge; this store is web-only.
  if (hasElectronBridge()) return false;
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  return (window.location.protocol === 'https:' || isLocalhost)
    && window.isSecureContext
    && typeof navigator.storage?.getDirectory === 'function';
};

/**
 * Whether audio bytes can be persisted at all. There is no Electron branch: the desktop bridge has no
 * audio-asset API, so the desktop build always answers "unsupported" instead of inventing one.
 */
export const isLocalAudioBinaryRuntimeSupported = (): boolean => (
  !hasElectronBridge() && isLocalAudioWebRuntimeSupported()
);

const getOpfsDirectory = async (create: boolean): Promise<FileSystemDirectoryHandle | null> => {
  if (!isLocalAudioBinaryRuntimeSupported()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const cacheRoot = await root.getDirectoryHandle(OPFS_ROOT_DIRECTORY, { create });
    return await cacheRoot.getDirectoryHandle(OPFS_LOCAL_AUDIO_DIRECTORY, { create });
  } catch {
    return null;
  }
};

// The descriptor is only trusted when it agrees with the bytes actually on disk: a mismatch (a
// truncated write, a replaced blob, a descriptor edited by hand) is reported as "absent".
const readOpfsDescriptor = async (
  directory: FileSystemDirectoryHandle,
  key: string,
): Promise<{ descriptor: LocalAudioFileDescriptor; file: File } | null> => {
  const names = getKeyFileNames(key);
  if (!names) return null;
  try {
    const [file, rawMetadata] = await Promise.all([
      directory.getFileHandle(names.data).then(handle => handle.getFile()),
      directory.getFileHandle(names.metadata).then(handle => handle.getFile()).then(value => value.text()),
    ]);
    const descriptor = JSON.parse(rawMetadata) as Partial<LocalAudioFileDescriptor>;
    const mimeType = normalizeAudioMimeType(descriptor.mimeType);
    const fileName = typeof descriptor.fileName === 'string' ? descriptor.fileName : '';
    if (descriptor.key !== key || !mimeType || !fileName || descriptor.size !== file.size || file.size <= 0) {
      return null;
    }
    return {
      descriptor: { key, fileName, mimeType, size: file.size, updatedAt: Number(descriptor.updatedAt) || 0 },
      file,
    };
  } catch {
    return null;
  }
};

export const writeLocalAudioBinary = async (
  key: string,
  value: unknown,
  fileName: string,
): Promise<LocalAudioBinaryWriteResult | null> => {
  const mimeType = resolveLocalAudioMimeType(value);
  const names = getKeyFileNames(key);
  if (!names || !isBlob(value) || value.size <= 0 || !mimeType) return null;

  const directory = await getOpfsDirectory(true);
  if (!directory) return null;
  const dataHandle = await directory.getFileHandle(names.data, { create: true });
  const metadataHandle = await directory.getFileHandle(names.metadata, { create: true });
  const dataWritable = await dataHandle.createWritable();
  try {
    await dataWritable.write(value);
    await dataWritable.close();
  } catch (error) {
    await dataWritable.abort().catch(() => undefined);
    throw error;
  }
  const descriptor: LocalAudioFileDescriptor = {
    key,
    fileName: fileName || sanitizeAudioFileName(fileName),
    mimeType,
    size: value.size,
    updatedAt: Date.now(),
  };
  const metadataWritable = await metadataHandle.createWritable();
  try {
    await metadataWritable.write(JSON.stringify(descriptor));
    await metadataWritable.close();
  } catch (error) {
    await metadataWritable.abort().catch(() => undefined);
    await directory.removeEntry(names.data).catch(() => undefined);
    throw error;
  }
  return { backend: 'opfs', mimeType, size: value.size };
};

/**
 * The stored audio bytes as a File, or null when nothing valid is stored for this key. The file is
 * named and typed from the descriptor rather than from the caller, because the descriptor is the part
 * that was validated against the bytes on disk.
 */
export const readLocalAudioBinary = async (key: string): Promise<File | null> => {
  const directory = await getOpfsDirectory(false);
  if (!directory) return null;
  const stored = await readOpfsDescriptor(directory, key);
  if (!stored) return null;
  return new File([stored.file], stored.descriptor.fileName, {
    type: stored.descriptor.mimeType,
    lastModified: stored.descriptor.updatedAt || stored.file.lastModified,
  });
};

export const hasLocalAudioBinary = async (key: string): Promise<boolean> => {
  const directory = await getOpfsDirectory(false);
  return directory ? Boolean(await readOpfsDescriptor(directory, key)) : false;
};

export const removeLocalAudioBinary = async (key: string): Promise<void> => {
  const names = getKeyFileNames(key);
  if (!names) return;
  const directory = await getOpfsDirectory(false);
  if (!directory) return;
  await Promise.all([
    directory.removeEntry(names.data).catch(() => undefined),
    directory.removeEntry(names.metadata).catch(() => undefined),
  ]);
};

export const clearLocalAudioBinaries = async (): Promise<void> => {
  if (!isLocalAudioWebRuntimeSupported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const cacheRoot = await root.getDirectoryHandle(OPFS_ROOT_DIRECTORY);
    await cacheRoot.removeEntry(OPFS_LOCAL_AUDIO_DIRECTORY, { recursive: true });
  } catch {
    // A missing local-audio directory is already clear.
  }
};

/**
 * Bytes the store currently holds, descriptors included. Walks the directory instead of trusting a
 * counter, so it stays correct after a partial delete or an interrupted import.
 */
export const estimateLocalAudioBinaryUsage = async (): Promise<number> => {
  const directory = await getOpfsDirectory(false);
  if (!directory) return 0;
  let total = 0;
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file') continue;
    try {
      total += (await entry.getFile()).size;
    } catch {
      // A concurrently removed entry contributes nothing.
    }
  }
  return total;
};
