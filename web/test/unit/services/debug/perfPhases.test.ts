import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    attributePerfPhase,
    beginPerfPhase,
    recentPerfPhases,
    recordPerfPhase,
    resetPerfPhases,
} from '@/services/debug/perfPhases';

// test/unit/services/debug/perfPhases.test.ts
// Guards the fallback attribution path: the phone's engine has no `long-animation-frame`, so a long
// task is attributed to whichever app phase was open when the task started. The rules that matter are
// containment (an open phase wins), the innermost of several open phases, and the two near-miss cases
// either side of an interval, because a phase's own close timer and a task's start never line up
// exactly.

afterEach(() => {
    resetPerfPhases();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('attributePerfPhase', () => {
    it('returns nothing when no phase was ever opened', () => {
        expect(attributePerfPhase(1000)).toBeNull();
    });

    it('attributes a task that started inside a finished phase', () => {
        recordPerfPhase('song change', 100, 260);
        expect(attributePerfPhase(150)).toBe('song change');
        expect(attributePerfPhase(100)).toBe('song change');
        expect(attributePerfPhase(260)).toBe('song change');
    });

    it('prefers the phase that opened last when several overlap', () => {
        recordPerfPhase('song change', 100, 300);
        recordPerfPhase('bg palette', 180, 280);
        expect(attributePerfPhase(200)).toBe('bg palette');
        expect(attributePerfPhase(120)).toBe('song change');
    });

    it('claims a task that started just before the phase opened', () => {
        // A long task starts, then a promise continuation enters the named call a few ms later.
        recordPerfPhase('cover palette', 104, 130);
        expect(attributePerfPhase(100)).toBe('cover palette');
    });

    it('claims a task that started just after a phase closed, but not a distant one', () => {
        recordPerfPhase('lyric line', 100, 200);
        expect(attributePerfPhase(240)).toBe('lyric line');
        expect(attributePerfPhase(1000)).toBeNull();
    });

    it('picks the nearer of two phases when the task falls between them', () => {
        recordPerfPhase('wall cull', 100, 150);
        recordPerfPhase('song change', 200, 250);
        expect(attributePerfPhase(160)).toBe('wall cull');
        expect(attributePerfPhase(190)).toBe('song change');
    });

    it('honours a wider tolerance when asked', () => {
        recordPerfPhase('song change', 100, 200);
        expect(attributePerfPhase(400, 250)).toBe('song change');
    });
});

describe('beginPerfPhase', () => {
    it('stays open until the current task ends, so a commit that follows stays inside it', () => {
        vi.useFakeTimers();
        vi.stubGlobal('window', {});
        beginPerfPhase('song change');
        // Still open: the timer that closes it runs after this task.
        expect(attributePerfPhase(performance.now() + 5)).toBe('song change');
        vi.runAllTimers();
        expect(Number.isFinite(recentPerfPhases()[0].endTime)).toBe(true);
    });

    it('keeps the mark list bounded', () => {
        vi.stubGlobal('window', {});
        for (let index = 0; index < 200; index += 1) recordPerfPhase(`phase ${index}`, index, index + 1);
        expect(recentPerfPhases().length).toBe(64);
        expect(recentPerfPhases()[63].name).toBe('phase 199');
    });
});
