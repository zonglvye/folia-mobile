import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAndroidRuntime, isAndroidShell } from '@/utils/platform';

// test/unit/utils/platform.test.ts
// Pins the two Android questions apart. `isAndroidShell` is about how the page was delivered (the
// packaged APK injects `window.foliaAndroid`); `isAndroidRuntime` is about the device, and is what
// quality-for-frame-time trade-offs ask, because a phone browser hitting the same build has the same
// weak GPU. Linux desktop must not answer yes to either: it has its own branches.

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 12; HUAWEI Pura 90 Pro Max) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const useRuntime = (userAgent: string, windowValue: Record<string, unknown> = {}) => {
    vi.stubGlobal('window', windowValue);
    vi.stubGlobal('navigator', { userAgent });
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isAndroidRuntime', () => {
    it('is false where there is no window at all', () => {
        expect(isAndroidRuntime()).toBe(false);
    });

    it('follows the user agent, so a phone browser counts as Android', () => {
        useRuntime(ANDROID_UA);
        expect(isAndroidRuntime()).toBe(true);
        useRuntime(WINDOWS_UA);
        expect(isAndroidRuntime()).toBe(false);
    });

    it('counts the packaged shell even when the user agent says nothing', () => {
        useRuntime(WINDOWS_UA, { foliaAndroid: {} });
        expect(isAndroidRuntime()).toBe(true);
    });

    it('never answers yes for Linux or Windows desktop', () => {
        useRuntime(LINUX_UA);
        expect(isAndroidRuntime()).toBe(false);
        useRuntime(WINDOWS_UA);
        expect(isAndroidRuntime()).toBe(false);
    });
});

describe('isAndroidShell', () => {
    it('is decided by the bridge, not by the user agent', () => {
        useRuntime(ANDROID_UA);
        expect(isAndroidShell()).toBe(false);
        useRuntime(WINDOWS_UA, { foliaAndroid: {} });
        expect(isAndroidShell()).toBe(true);
    });
});
