// src/components/visualizer/pixi/pixiTextureBudget.ts
//
// 同 pixi/loadPixi.ts：上游为了共享 bloom 把根目录的实现搬进了 pixi/，我们保留带补丁的根目录版本，
// 这里转发。花火的 hanabiTuning 正是从这里取 snapResolutionToTexturePool。
export * from '../pixiTextureBudget';
