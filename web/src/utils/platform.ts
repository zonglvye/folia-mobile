// src/utils/platform.ts
// One place to answer "is this a Mac", so keyboard handling and the shortcut hints the user reads
// can never disagree about it. Detection is by user agent because the renderer runs both in a
// browser and in Electron, and `window.electron?.platform` only exists in the latter.

export const isMacPlatform = typeof navigator !== 'undefined'
    && navigator.userAgent.toLowerCase().includes('mac');

/**
 * The modifier a shortcut declared as `ctrl` actually uses here: Cmd on macOS, Ctrl elsewhere.
 * Shortcuts are declared once with `ctrl` and translated at the point of use, rather than each
 * declaration carrying a per-platform variant.
 */
export const isPrimaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.metaKey : event.ctrlKey
);

/** The modifier that must stay *up* for a primary-modifier shortcut to be unambiguous. */
export const isSecondaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.ctrlKey : event.metaKey
);

/** Label for the primary modifier, for shortcut hints shown in the UI. */
export const PRIMARY_MODIFIER_LABEL = isMacPlatform ? 'Cmd' : 'Ctrl';

/**
 * Whether this build is running inside the Android shell that bundles the web app into the APK.
 * The shell injects `window.foliaAndroid` (see services/deviceAudioLibrary.ts); a browser and the
 * Electron main window both lack it. Detected by presence rather than user agent, so a phone
 * browser visiting the same build is not mistaken for the packaged app.
 *
 * The HarmonyOS shell injects the same object under the same name on purpose, so this answers true
 * there as well - and that is wanted: every packaged-shell branch (bundled NetEase provider, 60 fps
 * default, service worker retirement) applies to it. Use `getShellKind()` from
 * services/shellNowPlaying.ts to tell the two shells apart, never this.
 */
export const isAndroidShell = (): boolean => (
    typeof window !== 'undefined' && Boolean((window as { foliaAndroid?: unknown }).foliaAndroid)
);

/**
 * Whether this is running on Android at all: the packaged shell, or a phone browser visiting the same
 * build. Anything that trades picture quality for frame time asks this rather than `isAndroidShell`,
 * because the GPU being weak is a property of the device, not of how the page was delivered.
 */
export const isAndroidRuntime = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (isAndroidShell()) return true;
    return typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent);
};
