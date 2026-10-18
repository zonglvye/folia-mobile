import { describe, expect, it } from 'vitest';
import { planStaggeredRelease } from '@/library/suites/bravais/bravaisSlotStagger';
import type { WallSlot } from '@/components/wall/wallSlots';

// test/unit/library/bravais/bravaisSlotStagger.test.ts
// 一次重算新增的那一圈磁贴要不要分帧挂。起因是真机读数：滑动时 `longtasks 23 · max 210 ms`、
// `block (no phase)` —— 每次都栽在重算裁剪那一下。挑错这一条会直接看出来：首帧一格一格长、
// 或换层时波次被打散。

const slot = (column: number, row: number): WallSlot => ({
    key: `${column},${row},0`,
    column,
    row,
    slotIndex: 0,
    x: column * 136,
    y: row * 136,
    width: 128,
    height: 128,
    centerX: column * 136 + 64,
    centerY: row * 136 + 64,
    area: 1,
});

const keys = (set: ReadonlySet<string>) => [...set].sort();
const limits = { enabled: true, maxStaggered: 80 };

describe('staggered wall mounting', () => {
    it('gives the whole wall on the first pass, so it never grows in cell by cell', () => {
        const slots = [slot(0, 0), slot(1, 0), slot(2, 0)];
        const plan = planStaggeredRelease(null, slots, limits);
        expect(keys(plan.shown)).toEqual(['0,0,0', '1,0,0', '2,0,0']);
        expect(plan.queued).toEqual([]);
    });

    it('holds the ring a pan just added, and queues it in slot order', () => {
        const before = [slot(0, 0), slot(1, 0)];
        const after = [...before, slot(2, 0), slot(3, 0)];
        const plan = planStaggeredRelease(new Set(before.map(entry => entry.key)), after, limits);
        // 已经挂着的两张立刻留着：滑动中它们就在视野里，绝不能因为分帧而消失一帧。
        expect(keys(plan.shown)).toEqual(['0,0,0', '1,0,0']);
        expect(plan.queued).toEqual(['2,0,0', '3,0,0']);
    });

    it('drops keys that left without queueing anything', () => {
        const before = [slot(0, 0), slot(1, 0)];
        const after = [slot(1, 0)];
        const plan = planStaggeredRelease(new Set(before.map(entry => entry.key)), after, limits);
        expect(keys(plan.shown)).toEqual(['1,0,0']);
        expect(plan.queued).toEqual([]);
    });

    it('does not stagger while a whole-wall entrance is playing', () => {
        const after = [slot(0, 0), slot(1, 0), slot(2, 0)];
        const plan = planStaggeredRelease(new Set([slot(0, 0).key]), after, { ...limits, enabled: false });
        expect(keys(plan.shown)).toEqual(['0,0,0', '1,0,0', '2,0,0']);
        expect(plan.queued).toEqual([]);
    });

    it('does not stagger a wholesale content swap: that is not a pan ring', () => {
        const after = Array.from({ length: 82 }, (_, index) => slot(index, 0));
        const plan = planStaggeredRelease(new Set([slot(0, 0).key]), after, limits);
        expect(plan.queued).toEqual([]);
        expect(plan.shown.size).toBe(82);
    });

    it('staggers right up to the cap', () => {
        const after = Array.from({ length: 81 }, (_, index) => slot(index, 0));
        const plan = planStaggeredRelease(new Set([slot(0, 0).key]), after, limits);
        expect(plan.queued).toHaveLength(80);
        expect(plan.shown.size).toBe(1);
    });
});
