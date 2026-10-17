import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOW_BLUR_QUANTIZE_STORAGE_KEY, readStoredGlowBlurQuantize } from '@/utils/glowBlurQuantize';

// test/unit/visualizer/glowBlurQuantize.test.ts
// Pins the platform default of Lab > "歌词发光改用合成层绘制" (utils/glowBlurQuantize.ts). Linux needs it
// or the renderer runs out of fds; Android needs it because the same per-frame glyph re-raster is what
// pins the visualizer to 30 fps on the phone this app ships to. An explicit user choice always wins.

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 12; HUAWEI Pura 90 Pro Max) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface RuntimeStub {
    userAgent: string;
    window?: Record<string, unknown>;
    /** Value `localStorage.getItem` returns, i.e. a choice the user already made. */
    stored?: string | null;
}

/** Rebuilds the globals the module reads, so each case starts from a clean runtime. */
const useRuntime = ({ userAgent, window = {}, stored = null }: RuntimeStub) => {
    vi.stubGlobal('window', window);
    vi.stubGlobal('navigator', { userAgent });
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => (key === GLOW_BLUR_QUANTIZE_STORAGE_KEY ? stored : null),
    });
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('glow blur quantize platform default', () => {
    it('stays off on a desktop browser, where the leak costs a few MB a day', () => {
        useRuntime({ userAgent: WINDOWS_UA });
        expect(readStoredGlowBlurQuantize()).toBe(false);
    });

    it('is on for the Android phone, where the same re-raster is the frame-rate ceiling', () => {
        useRuntime({ userAgent: ANDROID_UA });
        expect(readStoredGlowBlurQuantize()).toBe(true);
    });

    it('is on inside the Android shell even when the user agent does not say Android', () => {
        useRuntime({ userAgent: WINDOWS_UA, window: { foliaAndroid: {} } });
        expect(readStoredGlowBlurQuantize()).toBe(true);
    });

    it('is on for Linux desktop, where the leak ends in a frozen compositor', () => {
        useRuntime({ userAgent: LINUX_UA });
        expect(readStoredGlowBlurQuantize()).toBe(true);
    });

    it('lets Electron override the user agent', () => {
        useRuntime({ userAgent: ANDROID_UA, window: { electron: { platform: 'win32' } } });
        expect(readStoredGlowBlurQuantize()).toBe(false);
        useRuntime({ userAgent: WINDOWS_UA, window: { electron: { platform: 'linux' } } });
        expect(readStoredGlowBlurQuantize()).toBe(true);
    });

    it('keeps a choice the user already made on either platform', () => {
        useRuntime({ userAgent: ANDROID_UA, stored: 'false' });
        expect(readStoredGlowBlurQuantize()).toBe(false);
        useRuntime({ userAgent: WINDOWS_UA, stored: 'true' });
        expect(readStoredGlowBlurQuantize()).toBe(true);
    });
});
