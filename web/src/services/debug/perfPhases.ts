// src/services/debug/perfPhases.ts
// Names the main-thread work that was running when a stall began.
//
// The engine this app ships to does not support the `long-animation-frame` entry type (the frame HUD
// reports `loaf: n/a` there), so the script / style+layout / render split is unavailable exactly where
// it would be most useful. What is available is `longtask`, which says a task blocked the main thread
// and when it started - so the question becomes "what was the app doing at that moment", and that is
// something the app can answer about itself.
//
// A phase is deliberately coarse-grained: it is opened where something user-visible happens (a song
// change, a lyric line change, the wall re-culling) and stays open until the current task ends, which
// keeps the React commit that follows a state update INSIDE the phase instead of after it.

export interface PerfPhaseMark {
    name: string;
    startTime: number;
    endTime: number;
}

/** Bounded: this only has to cover whatever happened in the last few seconds. */
const MAX_MARKS = 64;
/** A stall that begins this soon after a phase closed is still that phase's work. */
const ATTRIBUTION_TOLERANCE_MS = 60;

let marks: PerfPhaseMark[] = [];

const now = () => (typeof performance === 'undefined' ? 0 : performance.now());

/**
 * Opens a phase that closes when the current task ends. `setTimeout(0)` runs after the task and its
 * microtasks, so work React commits synchronously at the end of an update stays inside the phase.
 */
export const beginPerfPhase = (name: string): void => {
    if (typeof window === 'undefined') return;
    const mark: PerfPhaseMark = { name, startTime: now(), endTime: Number.POSITIVE_INFINITY };
    marks.push(mark);
    if (marks.length > MAX_MARKS) marks = marks.slice(marks.length - MAX_MARKS);
    setTimeout(() => {
        mark.endTime = now();
    }, 0);
};

/** A phase whose duration is already known (wrapping a synchronous call). */
export const recordPerfPhase = (name: string, startTime: number, endTime: number): void => {
    marks.push({ name, startTime, endTime });
    if (marks.length > MAX_MARKS) marks = marks.slice(marks.length - MAX_MARKS);
};

/**
 * Which phase a task that started at `startTime` belongs to, or null when nothing was close.
 *
 * Containment first, then the nearest boundary: a phase that begins a couple of milliseconds after
 * the task did is still that task's work (it started, then a named call was entered), and a phase
 * that ended just before it is the tail of the same work (the close timer is itself a task).
 */
export const attributePerfPhase = (startTime: number, toleranceMs = ATTRIBUTION_TOLERANCE_MS): string | null => {
    let innermost: PerfPhaseMark | null = null;
    let nearest: PerfPhaseMark | null = null;
    let nearestGap = Number.POSITIVE_INFINITY;

    for (const mark of marks) {
        if (startTime >= mark.startTime && startTime <= mark.endTime) {
            // Several phases can be open at once; the one that opened last is the most specific.
            if (!innermost || mark.startTime > innermost.startTime) innermost = mark;
            continue;
        }
        const gap = startTime < mark.startTime
            ? mark.startTime - startTime
            : startTime - (Number.isFinite(mark.endTime) ? mark.endTime : startTime);
        if (gap > toleranceMs || gap > nearestGap) continue;
        if (gap === nearestGap && nearest && mark.startTime <= nearest.startTime) continue;
        nearest = mark;
        nearestGap = gap;
    }

    return innermost?.name ?? nearest?.name ?? null;
};

export const recentPerfPhases = (): readonly PerfPhaseMark[] => marks;

export const resetPerfPhases = (): void => {
    marks = [];
};
