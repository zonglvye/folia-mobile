// src/components/visualizer/tuningDefinition.ts
//
// 上游 v0.7.22 tuningDefinition.ts 的最小子集，只为花火（hanabi）服务。
//
// 背景：上游 0.7.21 把「每种样式的参数」重构成了一套泛型契约（StoredTuning /
// VisualizerTuningAdapter / defineVisualizerTuning，并要求 settings store 按模式做模块增强）。
// 我们这条 0.7.20 分支上的等价物是 tuningRegistry.ts，形状完全不同，整套搬过来要同时迁移
// 13 个已有样式的参数定义，收益不划算。
//
// 花火真正需要的只有两件事：
//   1. numberWithin —— 参数归一化用的钳位（hanabiTuning.ts）
//   2. defineVisualizerTuning 返回一个 read(bundle)，让 entry.tsx 能拿到当前参数
// 所以这里给出与上游同名、同签名的这两个口子，语义按上游实现；等真要把整套 tuning 重构
// 搬进来时，替换本文件即可，花火那边一行都不用改。
import type { VisualizerTuningBundle } from './tuningRegistry';

/** 数值钳位：拿不到数就用默认值，越界夹到区间内。 */
export const numberWithin = (value: unknown, fallback: number, min: number, max: number) => (
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback
);

/** 一种样式的参数在本地怎么存、怎么合并。 */
export interface VisualizerTuningStorage<T> {
    /** localStorage 的键。 */
    key: string;
    /** 任何存下来的值 → 完整合法的参数。 */
    read: (raw: unknown) => T;
    /** 拖动滑块这类增量更新：先并再归一化。 */
    merge: (held: T, patch: Partial<T>) => T;
    /** 重置后提示文案的键。 */
    resetNotice?: string;
}

export interface VisualizerTuningDefinition<T> {
    /** 样式 id，与 registry 的 mode 一致。 */
    mode: string;
    /** 没有存档时的完整默认值。 */
    defaults: T;
    /** 这套参数在 store 里挂的字段名。 */
    settingsKey: string;
    settingsSetterKey: string;
    settingsResetterKey: string;
    storage: VisualizerTuningStorage<T>;
}

export interface VisualizerTuningAdapter<T = unknown> extends VisualizerTuningDefinition<T> {
    /**
     * 从渲染属性里的 tuning bundle 取这套参数；bundle 里没有就回落到本地存档。
     * 上游还兼顾 store 里的实时值，我们这里 store 没有这个字段，取存档即可。
     */
    read: (bundle?: VisualizerTuningBundle) => T;
}

/** 供各样式 `declare module` 增强的容器；本子集不往 store 里塞字段，所以是空的。 */
export interface VisualizerTuningSettings { }

/**
 * 上游用它把 `settingsKey` / `settingsSetterKey` / `settingsResetterKey` 三个字段
 * 一次性并进 settings store 的类型。这里保留同名类型，让样式的模块增强写法原样可用。
 */
export type StoredTuningFields<
    Field extends string,
    Setter extends string,
    Resetter extends string,
    T,
> = Record<Field, T> & Record<Setter, (patch: Partial<T>) => void> & Record<Resetter, () => void>;

const readFromStorage = <T>(storage: VisualizerTuningStorage<T>, fallback: T): T => {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage.getItem(storage.key);
        return raw === null ? fallback : storage.read(JSON.parse(raw));
    } catch {
        // 存档坏了不能让画面起不来：按默认参数画。
        return fallback;
    }
};

export const defineVisualizerTuning = <T>(definition: VisualizerTuningDefinition<T>): VisualizerTuningAdapter<T> => ({
    ...definition,
    read: (bundle) => {
        // 上游的 bundle 是按样式名索引的松散表；本地类型是按 mode 收紧过的，这里按下标取。
        const held = (bundle as Record<string, unknown> | undefined)?.[definition.settingsKey];
        return held === undefined
            ? readFromStorage(definition.storage, definition.defaults)
            : definition.storage.read(held);
    },
});
