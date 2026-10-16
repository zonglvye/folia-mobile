// src/services/localLibraryAvailability.ts
// Centralizes the secure-context requirement for browser local-library access, and separates the two
// browser entry points: the directory picker (File System Access API, desktop Chromium) and the plain
// file input (everywhere else, including Android Chrome and iOS Safari).

export interface LocalLibraryAvailability {
  supported: boolean;
  reason: 'insecure-http' | 'file-system-api-unavailable' | 'file-input-unavailable' | null;
}

export const getLocalLibraryAvailability = (): LocalLibraryAvailability => {
  if (typeof window === 'undefined') return { supported: false, reason: 'file-system-api-unavailable' };
  if (window.electron) return { supported: true, reason: null };
  const currentLocation = window.location;
  if (!currentLocation) return { supported: false, reason: 'file-system-api-unavailable' };
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(currentLocation.hostname);
  if (!(currentLocation.protocol === 'https:' || isLocalhost) || !window.isSecureContext) {
    return { supported: false, reason: 'insecure-http' };
  }
  if (!('showDirectoryPicker' in window) || typeof navigator.storage?.getDirectory !== 'function') {
    return { supported: false, reason: 'file-system-api-unavailable' };
  }
  return { supported: true, reason: null };
};

/**
 * Whether a plain file input can import local music. This is the directory picker's fallback entry:
 * Android Chrome and iOS Safari have no showDirectoryPicker, but they do have a multi-select file
 * input, and the imported bytes are persisted by the local audio store so playback needs no handle.
 * The input element itself is the only requirement, so an insecure context is still rejected (the
 * bytes could not be persisted there) but a missing File System Access API is not.
 */
export const getLocalFileImportAvailability = (): LocalLibraryAvailability => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { supported: false, reason: 'file-input-unavailable' };
  }
  const currentLocation = window.location;
  if (!currentLocation) return { supported: false, reason: 'file-input-unavailable' };
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(currentLocation.hostname);
  if (!(currentLocation.protocol === 'https:' || isLocalhost) || !window.isSecureContext) {
    return { supported: false, reason: 'insecure-http' };
  }
  // Electron already reaches every local file through its own bridge, and its renderer may not be a
  // secure context; the file input is the browser fallback, not a desktop entry.
  if (window.electron) return { supported: false, reason: 'file-input-unavailable' };
  return { supported: true, reason: null };
};
