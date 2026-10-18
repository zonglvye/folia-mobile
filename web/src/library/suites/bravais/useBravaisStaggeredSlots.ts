import { useEffect, useMemo, useRef, useState } from 'react';
import type { WallSlot } from '../../../components/wall/wallSlots';
import { BRAVAIS_WALL_MOUNT_BATCH, BRAVAIS_WALL_MOUNT_MAX_STAGGERED } from './bravaisConstants';
import { planStaggeredRelease } from './bravaisSlotStagger';

// src/library/suites/bravais/useBravaisStaggeredSlots.ts
// 交给墙去渲染的 slot 列表：一次重算新增的那一圈磁贴分几帧挂完（规则见 bravaisSlotStagger）。
// 只影响「画哪些」，不影响任何逻辑用的完整列表 —— stage 的 slotsRef / 键盘焦点 / 定位仍然拿全量的。
//
// 每一步只改一个字符串集合，React 每帧挂一批（BRAVAIS_WALL_MOUNT_BATCH 个）。换层、再来一次重算、
// 组件卸载都由 effect 的 cleanup 收掉，不会有两个泵同时在跑。

const sameKeys = (left: ReadonlySet<string>, right: ReadonlySet<string>) => (
    left.size === right.size && [...left].every(key => right.has(key))
);

export const useBravaisStaggeredSlots = (
    slots: readonly WallSlot[],
    enabled: boolean,
): readonly WallSlot[] => {
    /** 已经放行的 key；null = 还没放过任何一轮（首帧整面墙一次给）。 */
    const [shown, setShown] = useState<ReadonlySet<string> | null>(null);
    const shownRef = useRef<ReadonlySet<string> | null>(null);
    shownRef.current = shown;

    useEffect(() => {
        const plan = planStaggeredRelease(shownRef.current, slots, {
            enabled,
            maxStaggered: BRAVAIS_WALL_MOUNT_MAX_STAGGERED,
        });
        const queue = [...plan.queued];

        // 没有要摊的：一次落定（首帧、换层、只减不增都走这里）。集合没变就不碰 state。
        if (queue.length === 0) {
            if (shownRef.current === null || !sameKeys(shownRef.current, plan.shown)) {
                shownRef.current = plan.shown;
                setShown(plan.shown);
            }
            return undefined;
        }

        let frame: number | null = null;
        let released = 0;
        let cancelled = false;
        const step = () => {
            frame = null;
            if (cancelled) return;
            released = Math.min(queue.length, released + BRAVAIS_WALL_MOUNT_BATCH);
            const next = new Set(plan.shown);
            for (let index = 0; index < released; index += 1) next.add(queue[index]);
            shownRef.current = next;
            setShown(next);
            if (released < queue.length) frame = requestAnimationFrame(step);
        };
        // 第一帧先放行第一批，剩下的交给 rAF。
        step();
        return () => {
            cancelled = true;
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [enabled, slots]);

    return useMemo(() => {
        if (shown === null) return slots;
        return slots.filter(slot => shown.has(slot.key));
    }, [shown, slots]);
};
