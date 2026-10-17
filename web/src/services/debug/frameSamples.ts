// src/services/debug/frameSamples.ts
// Frame-time sampling for the in-app performance HUD.
//
// The phone this ships to has no adb channel (HarmonyOS exposes HDC on the USB vendor interface,
// not the Android debug interface), so `dumpsys gfxinfo` cannot be used on the device that actually
// matters. The only clock left is successive requestAnimationFrame timestamps, and it answers the
// question that was being asked anyway: did the compositor deliver the frames? A frame that never
// arrived shows up as a doubled delta whether the delay came from the main thread or from the GPU.

import { attributePerfPhase, resetPerfPhases } from './perfPhases';
//
// Cost discipline, because this exists to diagnose overhead and must not add any:
// - the deltas live in a preallocated ring buffer, so a frame writes one float and no allocation;
// - nothing here touches React. The HUD polls `readFrameStats` a couple of times a second, which is
//   when the single array copy happens;
// - sampling only runs while the HUD is visible.

/** A frame slower than this is two missed 60 Hz vsyncs, i.e. the user saw a stutter. */
export const FRAME_JANK_MS = 33.4;

/** ...but jank is measured against the session's own median, so a steady 30 fps is not "jank". */
const JANK_MEDIAN_FACTOR = 1.5;

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
    /** Long animation frames seen since the last reset, and the cost split of the worst one. */
    loafCount: number;
    loafWorst: LongFrameBreakdown | null;
    /**
     * Long tasks grouped by the app phase they started in, worst first. The fallback for engines
     * without `long-animation-frame`: it cannot say "script or paint", but it can say "this was the
     * song change", which is the next question one would ask anyway.
     */
    stallSources: readonly StallSource[];
}

export interface StallSource {
    phase: string;
    count: number;
    worstMs: number;
}

/**
 * Where a slow frame actually went, as `long-animation-frame` reports it. Script, style/layout and
 * render are separate budgets on Chromium, and each points at a different fix: a script-bound stall is
 * React work, a style/layout-bound one is a forced reflow, and a render-bound one is paint or GPU. The
 * frame-time percentiles alone cannot tell those apart, which matters on a phone with no adb.
 */
export interface LongFrameBreakdown {
    worstMs: number;
    scriptMs: number;
    styleAndLayoutMs: number;
    renderMs: number;
    /** Layout work the page forced by reading geometry inside a script, ms. */
    forcedStyleAndLayoutMs: number;
    /** The slowest script in the frame, when the engine names one. */
    slowestScript: { name: string; file: string } | null;
}

/** The `long-animation-frame` fields this sampler reads; typed here so the reduction is testable. */
export interface ScriptTimingLike {
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
    invoker?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
}

export interface LongAnimationFrameLike {
    /** Absolute (time-origin relative) start of the frame; the markers below use the same clock. */
    startTime: number;
    duration: number;
    renderStart?: number;
    styleAndLayoutStart?: number;
    scripts?: ReadonlyArray<ScriptTimingLike>;
}

const fileNameOf = (url: string | undefined): string => {
    if (!url) return '';
    const withoutQuery = url.split(/[?#]/)[0];
    return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
};

/**
 * Splits one long animation frame into script / style+layout / render. The regions are contiguous by
 * definition: render runs from `renderStart` to `styleAndLayoutStart`, and style+layout from there to
 * the end of the frame. Markers are absolute timestamps while `duration` is a span, so the end has to
 * be derived from `startTime`; a missing marker collapses to zero rather than inventing a split.
 */
export const summarizeLongAnimationFrame = (entry: LongAnimationFrameLike): LongFrameBreakdown => {
    const duration = Math.max(0, entry.duration);
    const frameStart = entry.startTime;
    const frameEnd = frameStart + duration;
    const renderStart = entry.renderStart ?? frameStart;
    const styleAndLayoutStart = entry.styleAndLayoutStart ?? 0;

    const renderMs = styleAndLayoutStart > 0
        ? Math.max(0, styleAndLayoutStart - renderStart)
        : Math.max(0, frameEnd - renderStart);
    const styleAndLayoutMs = styleAndLayoutStart > 0
        ? Math.max(0, frameEnd - styleAndLayoutStart)
        : 0;

    const scripts = entry.scripts ?? [];
    let scriptMs = 0;
    let forcedStyleAndLayoutMs = 0;
    let slowest: ScriptTimingLike | null = null;
    let slowestMs = -1;
    for (const script of scripts) {
        const scriptDuration = script.duration ?? 0;
        scriptMs += scriptDuration;
        forcedStyleAndLayoutMs += script.forcedStyleAndLayoutDuration ?? 0;
        if (scriptDuration > slowestMs) {
            slowestMs = scriptDuration;
            slowest = script;
        }
    }

    return {
        worstMs: duration,
        scriptMs,
        styleAndLayoutMs,
        renderMs,
        forcedStyleAndLayoutMs,
        slowestScript: slowest
            ? { name: slowest.sourceFunctionName || slowest.invoker || '(anonymous)', file: fileNameOf(slowest.sourceURL) }
            : null,
    };
};

/** Keeps the slowest frame of the window: the one worth explaining. */
export const worseLongFrame = (
    current: LongFrameBreakdown | null,
    next: LongFrameBreakdown,
): LongFrameBreakdown => (current && current.worstMs >= next.worstMs ? current : next);

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
    loafCount: 0,
    loafWorst: null,
    stallSources: [],
};

/**
 * Turns raw deltas into the numbers the HUD shows. Pure and exported so the percentile and
 * jank-threshold behaviour is covered by a unit test instead of by reading the HUD on a phone.
 */
export const computeFrameStats = (
    deltas: readonly number[],
    longTask: { count: number; longestMs: number },
    heapMB: number | null,
    loaf: { count: number; worst: LongFrameBreakdown | null } = { count: 0, worst: null },
    stallSources: readonly StallSource[] = [],
): FrameStats => {
    const frames = deltas.length;
    if (frames === 0) {
        return {
            ...EMPTY_FRAME_STATS,
            longTaskCount: longTask.count,
            longestTaskMs: longTask.longestMs,
            heapMB,
            loafCount: loaf.count,
            loafWorst: loaf.worst,
            stallSources,
        };
    }

    const sorted = deltas.slice().sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(frames - 1, Math.max(0, Math.ceil(p * frames) - 1))];
    const median = percentile(0.5);
    // Jank is deviation from what this session actually achieves, not a fixed 60 Hz budget: a phone
    // panel that runs at 90 Hz makes a rock-steady 30 fps land on 33.3-33.5 ms, which straddles the old
    // hardcoded 33.4 ms threshold and reported 19 % jank for frames that were all perfectly even.
    // The constant stays as a floor so a healthy 60 fps session still flags a two-vsync frame.
    const jankThresholdMs = Math.max(FRAME_JANK_MS, median * JANK_MEDIAN_FACTOR);
    let totalMs = 0;
    let jankFrames = 0;
    for (const delta of deltas) {
        totalMs += delta;
        if (delta > jankThresholdMs) jankFrames += 1;
    }

    return {
        frames,
        windowMs: totalMs,
        fps: totalMs > 0 ? (frames * 1000) / totalMs : 0,
        p50: median,
        p90: percentile(0.9),
        p99: percentile(0.99),
        worst: sorted[frames - 1],
        jankRatio: jankFrames / frames,
        longTaskCount: longTask.count,
        longestTaskMs: longTask.longestMs,
        heapMB,
        loafCount: loaf.count,
        loafWorst: loaf.worst,
        stallSources,
    };
};

// ---- ring buffer -----------------------------------------------------------

const deltas = new Float32Array(FRAME_CAPACITY);
let head = 0;
let count = 0;
let lastTimestamp = 0;
let rafHandle = 0;
let loafCount = 0;
let loafWorst: LongFrameBreakdown | null = null;
let loafObserver: PerformanceObserver | null = null;
let observer: PerformanceObserver | null = null;

/**
 * Long tasks with their timestamps and the phase each started in.
 *
 * Timestamped on purpose: the frame percentiles cover only the last FRAME_CAPACITY frames (~28 s at
 * 30 fps), so a counter that accumulated since the last reset made the two halves of the HUD describe
 * different periods. That is how "19 long tasks, max 591 ms" appeared next to a 1.2 % jank ratio that
 * a single 591 ms stall would by itself have exceeded - the 591 ms was startup, long outside the frame
 * window. Both halves now answer for the same span.
 */
interface StallSample {
    /** When the task started, on the same clock as the frame timestamps. */
    at: number;
    ms: number;
    phase: string;
}

const MAX_STALL_SAMPLES = 256;
let stallSamples: StallSample[] = [];
/** What a long task is attributed to when no phase was open: the app was idle by its own account. */
const UNATTRIBUTED_STALL = '(no phase)';
const MAX_STALL_SOURCES = 4;

const recordStall = (at: number, durationMs: number, phaseName: string | null) => {
    stallSamples.push({ at, ms: durationMs, phase: phaseName ?? UNATTRIBUTED_STALL });
    if (stallSamples.length > MAX_STALL_SAMPLES) {
        stallSamples = stallSamples.slice(stallSamples.length - MAX_STALL_SAMPLES);
    }
};

/** Worst first, capped: the HUD has room for one line but a test wants to see the order. */
const readStallSources = (windowStart: number): StallSource[] => {
    const byPhase = new Map<string, StallSource>();
    for (const sample of stallSamples) {
        if (sample.at < windowStart) continue;
        const current = byPhase.get(sample.phase);
        if (!current) {
            byPhase.set(sample.phase, { phase: sample.phase, count: 1, worstMs: sample.ms });
            continue;
        }
        current.count += 1;
        if (sample.ms > current.worstMs) current.worstMs = sample.ms;
    }
    return [...byPhase.values()]
        .sort((left, right) => right.worstMs - left.worstMs)
        .slice(0, MAX_STALL_SOURCES);
};

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
                // `longtask.attribution` names a container, not a cause. The app's own phase marks
                // know what it was doing, so ask them about the moment the task started.
                recordStall(entry.startTime, entry.duration, attributePerfPhase(entry.startTime));
            }
        });
        observer.observe({ entryTypes: ['longtask'] });
    } catch {
        observer = null;
    }

    // The same stalls split three ways. `longtask` says a frame was lost; `long-animation-frame` says
    // whether the time went to script, to style/layout or to render, which is what decides the fix.
    // Its own observer, so an engine without the entry type still reports long tasks.
    try {
        loafObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                loafCount += 1;
                loafWorst = worseLongFrame(
                    loafWorst,
                    summarizeLongAnimationFrame(entry as unknown as LongAnimationFrameLike),
                );
            }
        });
        loafObserver.observe({ entryTypes: ['long-animation-frame'] });
    } catch {
        loafObserver = null;
    }
};

const stopSampling = () => {
    if (rafHandle !== 0) {
        nativeCancelAnimationFrame()(rafHandle);
        rafHandle = 0;
    }
    observer?.disconnect();
    observer = null;
    loafObserver?.disconnect();
    loafObserver = null;
};

/** Drops the window, the long-task samples and the slowest-frame breakdown. */
export const resetFrameSamples = () => {
    head = 0;
    count = 0;
    lastTimestamp = 0;
    loafCount = 0;
    loafWorst = null;
    stallSamples = [];
    resetPerfPhases();
    notify();
};

export const readFrameStats = (): FrameStats => {
    const samples: number[] = [];
    const first = count === FRAME_CAPACITY ? head : 0;
    let windowMs = 0;
    for (let index = 0; index < count; index += 1) {
        const delta = deltas[(first + index) % FRAME_CAPACITY];
        samples.push(delta);
        windowMs += delta;
    }
    const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const heapMB = heap?.usedJSHeapSize ? heap.usedJSHeapSize / (1024 * 1024) : null;

    // Stalls are counted over the same span as the frames, so the two halves of the HUD describe one
    // period instead of two (see StallSample).
    const now = typeof performance === 'undefined' ? 0 : performance.now();
    const windowStart = windowMs > 0 ? now - windowMs : now;
    const inWindow = stallSamples.filter(sample => sample.at >= windowStart);
    let longestTaskMs = 0;
    for (const sample of inWindow) {
        if (sample.ms > longestTaskMs) longestTaskMs = sample.ms;
    }

    return computeFrameStats(
        samples,
        { count: inWindow.length, longestMs: longestTaskMs },
        heapMB,
        { count: loafCount, worst: loafWorst },
        readStallSources(windowStart),
    );
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
