// src/services/debug/frameSamples.ts
// Frame-time sampling for the in-app performance HUD.
//
// The phone this ships to has no adb channel (HarmonyOS exposes HDC on the USB vendor interface,
// not the Android debug interface), so `dumpsys gfxinfo` cannot be used on the device that actually
// matters. The only clock left is successive requestAnimationFrame timestamps, and it answers the
// question that was being asked anyway: did the compositor deliver the frames? A frame that never
// arrived shows up as a doubled delta whether the delay came from the main thread or from the GPU.
//
// Cost discipline, because this exists to diagnose overhead and must not add any:
// - the deltas live in a preallocated ring buffer, so a frame writes one float and no allocation;
// - nothing here touches React. The HUD polls `readFrameStats` a couple of times a second, which is
//   when the single array copy happens;
// - sampling only runs while the HUD is visible.

/** A frame slower than this is two missed 60 Hz vsyncs, i.e. the user saw a stutter. */
export const FRAME_JANK_MS = 33.4;

/**
 * Gaps longer than this are not dropped frames: they are the WebView being backgrounded, the screen
 * going off, or a debugger pause. Folding those into the percentiles would report a 60% jank ratio
 * every time the user switched apps.
 */
const MAX_SAMPLE_MS = 250;

/** ~10 s at 60 Hz, ~5 s at 120 Hz. Longer than a scroll gesture, short enough to stay current. */
const FRAME_CAPACITY = 900;

const FRAME_HUD_STORAGE_KEY = 'folia-frame-hud-visible';

export interface FrameStats {
    frames: number;
    /** Total measured time covered by the samples, ms. */
    windowMs: number;
    fps: number;
    p50: number;
    p90: number;
    p99: number;
    worst: number;
    /** Share of measured frames slower than FRAME_JANK_MS, 0..1. */
    jankRatio: number;
    longTaskCount: number;
    longestTaskMs: number;
    /** `performance.memory` is Chrome-only, so this is null where the runtime hides it. */
    heapMB: number | null;
}

export const EMPTY_FRAME_STATS: FrameStats = {
    frames: 0,
    windowMs: 0,
    fps: 0,
    p50: 0,
    p90: 0,
    p99: 0,
    worst: 0,
    jankRatio: 0,
    longTaskCount: 0,
    longestTaskMs: 0,
    heapMB: null,
};

/**
 * Turns raw deltas into the numbers the HUD shows. Pure and exported so the percentile and
 * jank-threshold behaviour is covered by a unit test instead of by reading the HUD on a phone.
 */
export const computeFrameStats = (
    deltas: readonly number[],
    longTask: { count: number; longestMs: number },
    heapMB: number | null,
): FrameStats => {
    const frames = deltas.length;
    if (frames === 0) {
        return { ...EMPTY_FRAME_STATS, longTaskCount: longTask.count, longestTaskMs: longTask.longestMs, heapMB };
    }

    const sorted = deltas.slice().sort((a, b) => a - b);
    let totalMs = 0;
    let jankFrames = 0;
    for (const delta of deltas) {
        totalMs += delta;
        if (delta > FRAME_JANK_MS) jankFrames += 1;
    }
    const percentile = (p: number) => sorted[Math.min(frames - 1, Math.max(0, Math.ceil(p * frames) - 1))];

    return {
        frames,
        windowMs: totalMs,
        fps: totalMs > 0 ? (frames * 1000) / totalMs : 0,
        p50: percentile(0.5),
        p90: percentile(0.9),
        p99: percentile(0.99),
        worst: sorted[frames - 1],
        jankRatio: jankFrames / frames,
        longTaskCount: longTask.count,
        longestTaskMs: longTask.longestMs,
        heapMB,
    };
};

// ---- ring buffer -----------------------------------------------------------

const deltas = new Float32Array(FRAME_CAPACITY);
let head = 0;
let count = 0;
let lastTimestamp = 0;
let rafHandle = 0;
let longTaskCount = 0;
let longestTaskMs = 0;
let observer: PerformanceObserver | null = null;

/**
 * The limiter patches `window.requestAnimationFrame`; measuring through the patch would report the
 * cap instead of the device. The limiter stashes the original here, so sample the real one.
 */
const nativeRequestAnimationFrame = (): ((callback: FrameRequestCallback) => number) => {
    const patch = window as Window & { __foliaNativeRequestAnimationFrame?: (callback: FrameRequestCallback) => number };
    return patch.__foliaNativeRequestAnimationFrame ?? window.requestAnimationFrame.bind(window);
};

/** Paired with `nativeRequestAnimationFrame`: a handle from one patch must be cancelled by it too. */
const nativeCancelAnimationFrame = (): ((handle: number) => void) => {
    const patch = window as Window & { __foliaNativeCancelAnimationFrame?: (handle: number) => void };
    return patch.__foliaNativeCancelAnimationFrame ?? window.cancelAnimationFrame.bind(window);
};

const step = (timestamp: number) => {
    if (lastTimestamp > 0) {
        const delta = timestamp - lastTimestamp;
        if (delta > 0 && delta < MAX_SAMPLE_MS) {
            deltas[head] = delta;
            head = (head + 1) % FRAME_CAPACITY;
            if (count < FRAME_CAPACITY) count += 1;
        }
    }
    lastTimestamp = timestamp;
    rafHandle = nativeRequestAnimationFrame()(step);
};

const startSampling = () => {
    if (rafHandle !== 0 || typeof window === 'undefined') return;
    lastTimestamp = 0;
    rafHandle = nativeRequestAnimationFrame()(step);

    // Long tasks are the JS half of the story: a frame can be late because a task blocked the main
    // thread for 200 ms. Not every engine has the entry type, and a throw here must not disable the
    // frame sampling that does work.
    try {
        observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                longTaskCount += 1;
                if (entry.duration > longestTaskMs) longestTaskMs = entry.duration;
            }
        });
        observer.observe({ entryTypes: ['longtask'] });
    } catch {
        observer = null;
    }
};

const stopSampling = () => {
    if (rafHandle !== 0) {
        nativeCancelAnimationFrame()(rafHandle);
        rafHandle = 0;
    }
    observer?.disconnect();
    observer = null;
};

/** Drops the window and the long-task counters. The next `readFrameStats` starts from empty. */
export const resetFrameSamples = () => {
    head = 0;
    count = 0;
    lastTimestamp = 0;
    longTaskCount = 0;
    longestTaskMs = 0;
    notify();
};

export const readFrameStats = (): FrameStats => {
    const samples: number[] = [];
    const first = count === FRAME_CAPACITY ? head : 0;
    for (let index = 0; index < count; index += 1) {
        samples.push(deltas[(first + index) % FRAME_CAPACITY]);
    }
    const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const heapMB = heap?.usedJSHeapSize ? heap.usedJSHeapSize / (1024 * 1024) : null;
    return computeFrameStats(samples, { count: longTaskCount, longestMs: longestTaskMs }, heapMB);
};

// ---- visibility ------------------------------------------------------------

let visible = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

const readStoredVisibility = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(FRAME_HUD_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

visible = readStoredVisibility();
if (visible) startSampling();

export const isFrameHudVisible = () => visible;

export const subscribeToFrameHud = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** Persisted so the HUD survives the reload a phone brings back with the app. */
export const setFrameHudVisible = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    try {
        window.localStorage.setItem(FRAME_HUD_STORAGE_KEY, next ? '1' : '0');
    } catch {
        // Session-only: the switch still works, it just will not come back after a reload.
    }
    if (next) {
        resetFrameSamples();
        startSampling();
    } else {
        stopSampling();
    }
    notify();
};

export const toggleFrameHudVisible = () => setFrameHudVisible(!visible);
