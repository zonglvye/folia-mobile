// src/utils/randomVisualizerModes.ts
//
// 「每首歌随机歌词动画」的抽签池。上游 v0.7.22 的实现，逐行照搬：
// 池子里只收内置样式（模组样式不进池：它们可以随时被禁用，抽到就没了），
// 归一化时按内置清单的顺序过滤、去重，池空了就退回「全部内置样式」。
import type { VisualizerMode } from '../types';
import { BUILTIN_VISUALIZER_MODES } from '../types/visualizerModes';

/** 能进随机池的样式：只可能是内置的那几种。 */
export type RandomVisualizerMode = typeof BUILTIN_VISUALIZER_MODES[number];

export const normalizeRandomVisualizerModes = (value: unknown): RandomVisualizerMode[] => {
    const selected = new Set(Array.isArray(value) ? value : []);
    const modes = BUILTIN_VISUALIZER_MODES.filter(mode => selected.has(mode));
    return modes.length > 0 ? modes : [...BUILTIN_VISUALIZER_MODES];
};

/** 在选中的池子里抽一个，尽量避开当前样式（池里只剩它一个时只能重抽自己）。 */
export const pickRandomVisualizerMode = (
    modes: readonly VisualizerMode[],
    current: VisualizerMode,
    random: () => number = Math.random,
): RandomVisualizerMode => {
    const selected = normalizeRandomVisualizerModes(modes);
    const alternatives = selected.filter(mode => mode !== current);
    const candidates = alternatives.length > 0 ? alternatives : selected;
    return candidates[Math.floor(random() * candidates.length)];
};
