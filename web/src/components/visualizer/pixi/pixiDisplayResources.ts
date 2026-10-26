// src/components/visualizer/pixi/pixiDisplayResources.ts
//
// 同 pixi/loadPixi.ts：上游把根目录的实现搬进了 pixi/，我们保留根目录那份（带自己的补丁），
// 这里只转发，让按新路径写的模块（花火、上游重构后的 lumiere）拿到的仍是同一个实现。
export * from '../pixiDisplayResources';
