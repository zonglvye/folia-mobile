// Copyright (c) 2026 chthollyphile
import { defineVisualizerTuning } from '../tuningRegistry';

// src/components/visualizer/hanabi/tuning.ts
// 把花火的参数接进本仓库的 tuning 注册表：store 里那一份（`hanabiTuning`）在渲染边界被注入成
// `props.hanabiTuning`，与其它 13 个样式走同一条路。
//
// 上游 v0.7.22 用的是另一套 tuningDefinition（泛型 StoredTuning + 模块增强）；我们这条分支上
// 等价物是 tuningRegistry，所以这里只声明「读哪个字段、用哪个 setter、注入成什么 prop」。
export default defineVisualizerTuning({
    mode: 'hanabi',
    settingsKey: 'hanabiTuning',
    settingsSetterKey: 'handleSetHanabiTuning',
    apply: (props, tuning) => ({ ...props, hanabiTuning: tuning }),
});
