// Copyright (c) 2026 chthollyphile
//
// 与上游 v0.7.22 的 hanabi/entry.tsx 的差异（都只在鸿蒙/手机这一侧，不涉及渲染本身）：
//   1. 补 `tuningKind: 'hanabi'` —— 我们的 registry 契约要求每个样式声明它。
//   2. 参数由 tuning 注册表注入成 props.hanabiTuning（见 ./tuning.ts），不再由 render 里手写。
//   3. 面板沿用本仓库的 RangeControl / SettingsSection 写法（见 ./HanabiSettingsPanel.tsx）。
//   4. 播放面板的两个快捷开关（画框、拼贴）暂时不注册：它们要上游 `VisualizerQuickControlsProps`
//      的另一套 props 形状，先把面板做齐。
import React from 'react';
import { BEAT_EFFECT_IDS } from '../../../services/beatFx/beatEffects';
import { defineVisualizer } from '../definition';
import HanabiSettingsPanel from './HanabiSettingsPanel';
import { DEFAULT_HANABI_TUNING } from './types';

const VisualizerHanabi = React.lazy(() => import('./VisualizerHanabi'));

// src/components/visualizer/hanabi/entry.tsx
// Registers 花火, the Japanese lyric-PV director: lyrics pop in on bright colour blocks, fireworks and MG
// stickers bloom along the words, and the whole world keeps rising shot after shot like a fireworks show.
export default defineVisualizer({
    mode: 'hanabi',
    order: 26,
    labelKey: 'ui.visualizerHanabi',
    labelFallback: '花火',
    previewSeed: 'hanabi',
    previewStartOffset: 0,
    tuningKind: 'hanabi',
    // 花火：一道升空尾迹，顶上开一朵花
    glyph: (
        <>
            <path d="M12 21v-8" opacity="0.5" />
            <path d="M12 9V4M12 9l3.5-3.5M12 9l-3.5-3.5M12 9h5M12 9H7M12 9l3.5 3.5M12 9l-3.5 3.5" />
        </>
    ),
    command: {
        title: 'Visualizer: Hanabi',
        description: 'Switch to Hanabi visualizer',
        keywords: ['hanabi', '花火', '烟花', 'fireworks', 'lyric pv', 'anime pv'],
    },
    // 智能动感模式: beat_this' beat list schedules shells that burst on the beats, and the beat envelopes
    // punch the whole scene (hanabiBeatFx.ts). 手机上这两条目前恒不触发（没有节拍分析，见 services/beatFx）。
    beatEffects: [
        {
            id: BEAT_EFFECT_IDS.hanabiBeatBursts,
            nameKey: 'options.beatEffect_hanabiBeatBursts',
            descKey: 'options.beatEffect_hanabiBeatBurstsDesc',
            source: 'beats',
        },
        {
            id: BEAT_EFFECT_IDS.hanabiBeatPulse,
            nameKey: 'options.beatEffect_hanabiBeatPulse',
            descKey: 'options.beatEffect_hanabiBeatPulseDesc',
            source: 'beats',
        },
    ],
    // Deliberately unkeyed on the seed, like lumiere: the runtime hands a track change over in
    // place (songHandover.ts / pixiRuntimeHost.ts) instead of throwing the WebGL context away.
    render: props => <VisualizerHanabi {...props} hanabiTuning={props.hanabiTuning ?? DEFAULT_HANABI_TUNING} />,
    renderSettingsPanel: props => <HanabiSettingsPanel {...props} />,
    ownFontSizeNoticeKey: 'options.hanabiFontSizeAutoNotice',
});
