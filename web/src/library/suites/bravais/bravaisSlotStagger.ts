// src/library/suites/bravais/bravaisSlotStagger.ts
// 「一次重算新增的磁贴要不要分帧挂」的纯规则。
//
// 起因（2026-10 真机读数）：墙面滑动时 HUD 报 `longtasks 23 · max 210 ms`、`block (no phase)`。
// 长任务没有归属，说明不在取色那类记过账的代码里 —— 是重算裁剪时那一圈新磁贴的渲染 + 样式 + 布局。
// 手机上相机缩放 0.64，裁剪门槛 `OVERSCAN − CULL_EDGE_MARGIN` 换算下来约每滑 160px 就重算一次，
// 每次挂上二三十个新磁贴，正好一次长任务。
//
// 那一圈磁贴本来就在视野外（overscan 的全部意义），所以把它们摊到几帧挂是看不见的：一次 90ms
// 的卡顿变成三次 30ms。这条规则只决定「这一轮哪些立刻可见、哪些排队」，rAF 的节奏在 hook 里。

import type { WallSlot } from '../../../components/wall/wallSlots';

export type StaggerPlan = {
    /** 这一轮立刻可见的 key。 */
    shown: ReadonlySet<string>;
    /** 需要分帧挂载的 key，按 slots 原本的顺序。 */
    queued: readonly string[];
};

/**
 * 一次 `slots` 变化之后该怎么放行。
 *
 * - `previous === null`（首帧、换层后重新挂载）：一次全给，否则墙会一格一格地长出来；
 * - `enabled === false`（墙上正在跑整墙入场 / 出场波次）：一次全给，摊开会把波次打散；
 * - 新增超过 `maxStaggered`：一次全给 —— 那不是滑动带出来的一圈，而是整面墙换了内容，摊开
 *   只会让人看着墙一直不画完。
 * - 只减不增：立刻丢掉离场的 key，不排队。
 */
export const planStaggeredRelease = (
    previous: ReadonlySet<string> | null,
    slots: readonly WallSlot[],
    { enabled, maxStaggered }: { enabled: boolean; maxStaggered: number },
): StaggerPlan => {
    const current = new Set(slots.map(slot => slot.key));
    const all = (): StaggerPlan => ({ shown: current, queued: [] });

    if (previous === null || !enabled) return all();

    const added: string[] = [];
    const kept = new Set<string>();
    for (const key of current) {
        if (previous.has(key)) kept.add(key);
        else added.push(key);
    }

    if (added.length === 0) return { shown: kept, queued: [] };
    if (added.length > maxStaggered) return all();

    return { shown: kept, queued: added };
};
