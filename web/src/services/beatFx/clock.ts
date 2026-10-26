// src/services/beatFx/clock.ts
//
// 上游 clock.ts 的子集：只有「一个节拍事件长什么样」和「这一拍该多用力」这两件纯函数，
// 不带包络推进（那部分要 BeatAccents 分析结果，见 beatFxLive.ts 的说明）。
// 字段与语义按上游 v0.7.22 原样保留，将来补全整只文件时上层调用不需要改。

/** 一拍还是一小节的第一拍。 */
export type BeatFxEventKind = 'beat' | 'downbeat';

export interface BeatFxEvent {
    /** 距离曲子开头的秒数。 */
    t: number;
    kind: BeatFxEventKind;
    /** 0..1，这一拍有多重；没有重音数据时缺省。 */
    impact?: number;
    /** 各频段占这一拍的比例（和为 1）；没有重音数据时缺省。 */
    tone?: { low: number; mid: number; high: number };
    /** 距上一个小节第一拍隔了几拍（0 = 就是那一拍）；第一拍之前是 null。 */
    barPos?: number | null;
    /** 小节里完全没有节奏（只有持续音）时为 false：这一拍不触发效果。 */
    rhythmic?: boolean;
}

/** 轻拍也至少冲到这么高，看得见，只是弱一些。 */
export const BEAT_FX_WEAK_BEAT_FLOOR = 0.35;

/**
 * 这一拍的包络该冲到多高：没有重音数据时为 1；有则按 impact 在地板与 1 之间插值，
 * 再乘整首曲子的动态范围倍率；没有节奏的小节为 0。
 */
export const resolveBeatFxAccentGain = (
    event: Pick<BeatFxEvent, 'impact' | 'rhythmic'> | null | undefined,
    trackScale: number,
): number => {
    if (event?.rhythmic === false) return 0;
    if (!event || event.impact === undefined) return trackScale;
    return (BEAT_FX_WEAK_BEAT_FLOOR + (1 - BEAT_FX_WEAK_BEAT_FLOOR) * event.impact) * trackScale;
};
