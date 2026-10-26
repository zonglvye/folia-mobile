// src/services/beatFx/beatEffects.ts
//
// 智能动感效果的登记表。上游这一层还要处理「开/关 + 强度」的设置读写（SmartBeatSettings 那一套），
// 我们底子上没有那套设置存储，所以这里只留 id 与描述形状：花火的 entry 用它声明自己有两个可调效果，
// registry 只是把它登记下来，不读就不生效（见 beatFxLive 的替身说明）。
export type BeatEffectSource = 'beats' | 'drums';

/** 一个可调效果：id、文案键、数据来源。 */
export interface BeatEffectDef {
    id: string;
    nameKey: string;
    descKey: string;
    source: BeatEffectSource;
}

/** 目前只登记花火用到的两个。上游其余的 id 等到真正接上分析服务再补。 */
export const BEAT_EFFECT_IDS = {
    hanabiBeatBursts: 'hanabiBeatBursts',
    hanabiBeatPulse: 'hanabiBeatPulse',
} as const;
