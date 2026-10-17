import { describe, expect, it } from 'vitest';
import { computeFrameStats, EMPTY_FRAME_STATS, FRAME_JANK_MS } from '../../../../src/services/debug/frameSamples';

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
});
