import { describe, expect, it } from 'vitest';
import {
    computeFrameStats,
    EMPTY_FRAME_STATS,
    FRAME_JANK_MS,
    summarizeLongAnimationFrame,
    worseLongFrame,
} from '../../../../src/services/debug/frameSamples';

// test/unit/services/debug/frameSamples.test.ts

describe('computeFrameStats', () => {
    it('reports an empty window without dividing by zero', () => {
        expect(computeFrameStats([], { count: 0, longestMs: 0 }, null)).toEqual(EMPTY_FRAME_STATS);
    });

    it('derives fps from the measured span rather than assuming 60', () => {
        // Five frames spanning 116.8 ms, i.e. one 50 ms stall among healthy ones.
        const stats = computeFrameStats([16.7, 16.7, 16.7, 16.7, 50], { count: 0, longestMs: 0 }, null);
        expect(stats.frames).toBe(5);
        expect(stats.windowMs).toBeCloseTo(116.8, 5);
        expect(stats.fps).toBeCloseTo(42.8, 1);
    });

    it('counts only frames slower than the jank threshold', () => {
        // Exactly at the threshold is not jank; one millisecond over is.
        const stats = computeFrameStats([16.7, 16.7, FRAME_JANK_MS, FRAME_JANK_MS + 1], { count: 0, longestMs: 0 }, null);
        expect(stats.jankRatio).toBeCloseTo(0.25, 5);
    });

    it('does not call a rock-steady slow session janky', () => {
        // A 90 Hz panel that only manages every third vsync sits at 33.3-33.5 ms, which straddles the
        // old hardcoded 33.4 ms threshold and read as 19 % jank on the phone. Even frames are not
        // stutter: the rate is low (reported by fps), the delivery is not erratic.
        const steady = [33.3, 33.4, 33.5, 33.3, 33.5, 33.4];
        const stats = computeFrameStats(steady, { count: 0, longestMs: 0 }, null);
        expect(stats.jankRatio).toBe(0);
        expect(stats.fps).toBeCloseTo(30, 0);
    });

    it('still flags the frames that break away from the session median once it is slow', () => {
        const mixed = [33.3, 33.3, 33.3, 33.3, 120];
        const stats = computeFrameStats(mixed, { count: 0, longestMs: 0 }, null);
        expect(stats.jankRatio).toBeCloseTo(0.2, 5);
    });

    it('keeps percentiles ordered and carries long-task and heap readings through', () => {
        const stats = computeFrameStats([16.7, 16.7, 16.7, 16.7, 50], { count: 2, longestMs: 120 }, 148.2);
        expect(stats.p50).toBeCloseTo(16.7, 5);
        expect(stats.p90).toBe(50);
        expect(stats.p99).toBe(50);
        expect(stats.worst).toBe(50);
        expect(stats.longTaskCount).toBe(2);
        expect(stats.longestTaskMs).toBe(120);
        expect(stats.heapMB).toBeCloseTo(148.2, 5);
    });

    it('does not reorder the array it was given', () => {
        const deltas = [30, 10, 20];
        computeFrameStats(deltas, { count: 0, longestMs: 0 }, null);
        expect(deltas).toEqual([30, 10, 20]);
    });

    it('carries the slowest-frame breakdown through even when no frames were sampled yet', () => {
        const loaf = summarizeLongAnimationFrame({ startTime: 1000, duration: 155 });
        const stats = computeFrameStats([], { count: 0, longestMs: 0 }, null, { count: 3, worst: loaf });
        expect(stats.loafCount).toBe(3);
        expect(stats.loafWorst).toBe(loaf);
    });
});

describe('summarizeLongAnimationFrame', () => {
    // A 155 ms frame that started at t=5000: scripts ran to 5130, style/layout to 5140, paint to 5155.
    const frame = {
        startTime: 5000,
        duration: 155,
        renderStart: 5100,
        styleAndLayoutStart: 5140,
        scripts: [
            { duration: 60, forcedStyleAndLayoutDuration: 12, sourceFunctionName: 'renderWall', sourceURL: 'https://x/assets/bundle-abc.js?v=1' },
            { duration: 40, invoker: 'MessagePort' },
        ],
    };

    it('splits the frame into script, style/layout and render on the same clock', () => {
        const breakdown = summarizeLongAnimationFrame(frame);
        expect(breakdown.worstMs).toBe(155);
        expect(breakdown.scriptMs).toBe(100);
        expect(breakdown.renderMs).toBe(40); // renderStart -> styleAndLayoutStart
        expect(breakdown.styleAndLayoutMs).toBe(15); // styleAndLayoutStart -> end
        expect(breakdown.forcedStyleAndLayoutMs).toBe(12);
    });

    it('names the slowest script and strips the query off its file', () => {
        expect(summarizeLongAnimationFrame(frame).slowestScript).toEqual({
            name: 'renderWall',
            file: 'bundle-abc.js',
        });
    });

    it('falls back through invoker, then to anonymous, and never invents a file', () => {
        const unnamed = summarizeLongAnimationFrame({
            startTime: 0,
            duration: 80,
            scripts: [{ duration: 50, invoker: 'MessagePort' }, { duration: 70 }],
        });
        expect(unnamed.slowestScript).toEqual({ name: '(anonymous)', file: '' });
        const viaInvoker = summarizeLongAnimationFrame({
            startTime: 0,
            duration: 80,
            scripts: [{ duration: 70, invoker: 'MessagePort' }],
        });
        expect(viaInvoker.slowestScript).toEqual({ name: 'MessagePort', file: '' });
    });

    it('reports an all-render frame when the engine gives no style/layout marker', () => {
        const breakdown = summarizeLongAnimationFrame({ startTime: 100, duration: 90, renderStart: 110 });
        expect(breakdown.styleAndLayoutMs).toBe(0);
        expect(breakdown.renderMs).toBe(80);
        expect(breakdown.scriptMs).toBe(0);
        expect(breakdown.slowestScript).toBeNull();
    });

    it('clamps markers that disagree rather than reporting negative time', () => {
        const breakdown = summarizeLongAnimationFrame({
            startTime: 0,
            duration: 60,
            renderStart: 50,
            styleAndLayoutStart: 40,
        });
        expect(breakdown.renderMs).toBe(0);
        expect(breakdown.styleAndLayoutMs).toBe(20);
    });

    it('keeps whichever of two frames was slower', () => {
        const slow = summarizeLongAnimationFrame({ startTime: 0, duration: 200 });
        const fast = summarizeLongAnimationFrame({ startTime: 0, duration: 90 });
        expect(worseLongFrame(slow, fast)).toBe(slow);
        expect(worseLongFrame(fast, slow)).toBe(slow);
        expect(worseLongFrame(null, fast)).toBe(fast);
    });
});
