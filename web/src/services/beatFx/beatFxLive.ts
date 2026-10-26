// src/services/beatFx/beatFxLive.ts
//
// 手机壳里的智能动感（beat FX）替身。
//
// 上游这一层是「节拍表装好以后，随着播放把包络推到当前时刻」的实时钟，它依赖
// services/analysis/（beatThis 推理、鼓点分离、trackAudio 取轨）——那整套是 0.7.21 才进主干的，
// 我们这条 0.7.20 的分支上没有，硬搬要把推理服务和 WebGPU 一起带进来，代价远大于收益。
//
// 所以这里只保留花火（hanabi）引用的那几个查询口，一律答「没有节拍」：
//   花火里所有跟拍动画都以 isBeatFxReady() 为前置条件，返回 false 时整段跳过，
//   画面与「没开智能动感」时完全一致。等以后真把分析服务搬进来，替换这个文件即可，
//   上层调用方一行都不用改。
import type { BeatFxEvent } from './clock';

/** 节拍表永远没有装好：没有分析结果。 */
export const isBeatFxReady = (): boolean => false;

/** 一个节拍事件都没有。 */
export const getBeatFxEvents = (): readonly BeatFxEvent[] => [];

/** 包络恒为 0：拍点不动画面。 */
export const getBeatFxIntensities = (): Readonly<{ beat: number; downbeat: number }> => ({ beat: 0, downbeat: 0 });

/** 不换边。 */
export const getBeatFxRotationSign = (): number => 1;

/** 动态范围倍率取中性值 1（上游没有分析结果时也是 1）。 */
export const getBeatFxTrackScale = (): number => 1;

/** 每个效果的强度都是 0：等于全部关掉。 */
export const getBeatEffectStrength = (_id: string): number => 0;
