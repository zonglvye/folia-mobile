// src/services/shellNowPlaying.ts
// Mirrors the displayed track into a packaged shell's system-level now-playing surface: the
// HarmonyOS shell's AVSession (lock screen, control centre, Bluetooth transport buttons).
//
// The page stays the source of truth for playback. This module only forwards - it never stores,
// never retries, and never throws into a caller, because a shell that cannot answer must not be
// able to break playback.
//
// The wire format is the Android shell's `setPlaybackSnapshot` payload, unchanged, so both shells
// can read the same JSON and the page needs one publisher rather than one per platform.

export type ShellNowPlaying = {
    hasTrack: boolean;
    playing: boolean;
    title: string;
    artist: string;
    album: string;
    /** Whole seconds, matching what the shells take. Sub-second position buys nothing on a lock screen. */
    durationSec: number;
    positionSec: number;
    artworkUrl: string;
};

/** A transport command the shell sends back after the user pressed something outside the page. */
export type ShellMediaCommand = {
    command: 'play' | 'pause' | 'prev' | 'next';
};

/** DOM event both shells use for the shell-to-page direction. */
export const SHELL_MEDIA_COMMAND_EVENT = 'folia-android-media-command';

const HARMONY_SHELL_KIND = 'harmony';

/**
 * Whether the shell in front of us mirrors now-playing into the system and wants snapshots.
 *
 * Asked explicitly rather than "does `setPlaybackSnapshot` exist": the Android shell declares the
 * same method but has never started its foreground service on a device. A page that starts one on
 * a music app's first launch is exactly the kind of untested change that turns "no notification"
 * into "no playback", so the Android shell keeps answering without a kind and stays dormant until
 * that path is exercised on hardware.
 */
export const isShellNowPlayingSupported = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.foliaAndroid?.getShellKind?.() === HARMONY_SHELL_KIND;
    } catch {
        return false;
    }
};

/**
 * Which cover URL the shell should mirror onto the lock screen.
 *
 * The shell downloads the image itself (its `AVMetadata.mediaImage` needs a `PixelMap`), so it can
 * only fetch something reachable from outside the page. `blob:` URLs (what `coverCache` hands back),
 * `data:` URLs and the same-origin `/api/lyric-proxy?...` wrappers are all page-local or shell-local
 * and would silently fail, so only a remote http(s) URL is passed through; anything else becomes an
 * empty string and the lock screen simply has no artwork.
 */
export const resolveShellArtworkUrl = (cachedCover: string | null, remoteCover: string | null): string => {
    const candidates: Array<string | null> = [cachedCover, remoteCover];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
            return candidate;
        }
    }
    return '';
};

/** Pushes one snapshot. Failures are swallowed: mirroring a track is never load-bearing. */
export const publishShellNowPlaying = (snapshot: ShellNowPlaying): void => {
    if (typeof window === 'undefined') return;

    const bridge = window.foliaAndroid;
    if (typeof bridge?.setPlaybackSnapshot !== 'function') return;

    try {
        bridge.setPlaybackSnapshot(JSON.stringify(snapshot));
    } catch {
        // A shell that throws on its own bridge is a shell problem the page cannot fix.
    }
};

const SHELL_MEDIA_COMMANDS: ReadonlySet<string> = new Set(['play', 'pause', 'prev', 'next']);

const isShellMediaCommand = (value: unknown): value is ShellMediaCommand => {
    if (typeof value !== 'object' || value === null) return false;
    const command = (value as { command?: unknown }).command;
    return typeof command === 'string' && SHELL_MEDIA_COMMANDS.has(command);
};

/**
 * Listens for transport commands from the shell. Returns the unsubscribe function, so a React
 * effect can hand it straight back as its cleanup.
 *
 * Unknown commands are dropped rather than guessed at: a future shell adding `seek` must not have
 * it silently reinterpreted as a play/pause here.
 */
export const subscribeShellMediaCommands = (
    handler: (command: ShellMediaCommand) => void
): (() => void) => {
    if (typeof window === 'undefined' || !isShellNowPlayingSupported()) {
        return () => undefined;
    }

    const listener = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (isShellMediaCommand(detail)) {
            handler(detail);
        }
    };

    window.addEventListener(SHELL_MEDIA_COMMAND_EVENT, listener);
    return () => window.removeEventListener(SHELL_MEDIA_COMMAND_EVENT, listener);
};
