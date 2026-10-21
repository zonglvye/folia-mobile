import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SHELL_MEDIA_COMMAND_EVENT,
    isShellNowPlayingSupported,
    publishShellNowPlaying,
    subscribeShellMediaCommands,
} from '@/services/shellNowPlaying';

// test/unit/services/shellNowPlaying.test.ts
// Pins the shell->system mirror and its reverse channel. Three things must not drift:
//
//   1. The payload keys are the Android shell's `setPlaybackSnapshot` keys. Both shells parse this
//      JSON, so a rename here silently empties the lock screen rather than failing loudly.
//   2. The gate is `getShellKind() === 'harmony'`, not "does the method exist" - the Android shell
//      declares the method but must stay dormant until its foreground service is tested on hardware.
//   3. Nothing in here may throw into a caller. A shell that cannot answer must not break playback.

type Bridge = {
    getShellKind?: () => string;
    setPlaybackSnapshot?: (json: string) => void;
};

const makeWindow = (bridge?: Bridge) => {
    const target = new EventTarget() as EventTarget & { foliaAndroid?: Bridge };
    if (bridge) {
        target.foliaAndroid = bridge;
    }
    return target;
};

const HARMONY_BRIDGE = (overrides: Partial<Bridge> = {}): Bridge => ({
    getShellKind: () => 'harmony',
    setPlaybackSnapshot: vi.fn(),
    ...overrides,
});

const SNAPSHOT = {
    hasTrack: true,
    playing: true,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    durationSec: 213,
    positionSec: 42,
    artworkUrl: 'https://example.test/cover.jpg',
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isShellNowPlayingSupported', () => {
    it('is false where there is no window at all', () => {
        expect(isShellNowPlayingSupported()).toBe(false);
    });

    it('is false for a browser and for a shell that will not say what it is', () => {
        vi.stubGlobal('window', makeWindow());
        expect(isShellNowPlayingSupported()).toBe(false);

        // The Android shell's shape: the method exists, but there is no kind.
        vi.stubGlobal('window', makeWindow({ setPlaybackSnapshot: vi.fn() }));
        expect(isShellNowPlayingSupported()).toBe(false);
    });

    it('is true only for the harmony kind', () => {
        vi.stubGlobal('window', makeWindow({ getShellKind: () => 'harmony' }));
        expect(isShellNowPlayingSupported()).toBe(true);

        vi.stubGlobal('window', makeWindow({ getShellKind: () => 'android' }));
        expect(isShellNowPlayingSupported()).toBe(false);
    });

    it('treats a throwing bridge as unsupported', () => {
        vi.stubGlobal('window', makeWindow({
            getShellKind: () => { throw new Error('bridge gone'); },
        }));
        expect(isShellNowPlayingSupported()).toBe(false);
    });
});

describe('publishShellNowPlaying', () => {
    it('sends the snapshot as one JSON string with the keys both shells parse', () => {
        const setPlaybackSnapshot = vi.fn();
        vi.stubGlobal('window', makeWindow({ getShellKind: () => 'harmony', setPlaybackSnapshot }));

        publishShellNowPlaying(SNAPSHOT);

        expect(setPlaybackSnapshot).toHaveBeenCalledTimes(1);
        const payload: unknown = setPlaybackSnapshot.mock.calls[0][0];
        expect(typeof payload).toBe('string');
        expect(JSON.parse(payload as string)).toEqual(SNAPSHOT);
    });

    it('does nothing without a bridge, and never throws into the caller', () => {
        vi.stubGlobal('window', makeWindow());
        expect(() => publishShellNowPlaying(SNAPSHOT)).not.toThrow();

        vi.stubGlobal('window', makeWindow({
            setPlaybackSnapshot: () => { throw new Error('bridge gone'); },
        }));
        expect(() => publishShellNowPlaying(SNAPSHOT)).not.toThrow();
    });
});

describe('subscribeShellMediaCommands', () => {
    const dispatch = (target: EventTarget, detail: unknown) => {
        target.dispatchEvent(new CustomEvent(SHELL_MEDIA_COMMAND_EVENT, { detail }));
    };

    it('delivers the four transport commands', () => {
        const target = makeWindow(HARMONY_BRIDGE());
        vi.stubGlobal('window', target);
        const handler = vi.fn();

        const unsubscribe = subscribeShellMediaCommands(handler);
        dispatch(target, { command: 'play' });
        dispatch(target, { command: 'pause' });
        dispatch(target, { command: 'prev' });
        dispatch(target, { command: 'next' });

        expect(handler.mock.calls.map(call => (call[0] as { command: string }).command))
            .toEqual(['play', 'pause', 'prev', 'next']);

        unsubscribe();
        dispatch(target, { command: 'play' });
        expect(handler).toHaveBeenCalledTimes(4);
    });

    it('drops commands it does not understand rather than guessing at them', () => {
        const target = makeWindow(HARMONY_BRIDGE());
        vi.stubGlobal('window', target);
        const handler = vi.fn();

        subscribeShellMediaCommands(handler);
        // A future shell's `seek` must not be reinterpreted as play/pause here.
        dispatch(target, { command: 'seek', positionSec: 10 });
        dispatch(target, null);
        dispatch(target, 'next');
        dispatch(target, {});

        expect(handler).not.toHaveBeenCalled();
    });

    it('subscribes to nothing when the shell is not one that mirrors now-playing', () => {
        const target = makeWindow();
        vi.stubGlobal('window', target);
        const handler = vi.fn();

        const unsubscribe = subscribeShellMediaCommands(handler);
        dispatch(target, { command: 'play' });

        expect(handler).not.toHaveBeenCalled();
        expect(() => unsubscribe()).not.toThrow();
    });
});
