// src/components/visualizer/pixi/loadPixi.ts
//
// 上游 0.7.21 把 visualizer 根目录下这几个 pixi 模块搬进了 pixi/ 子目录，花火（hanabi）是按新路径写的。
// 我们这边的根目录版本带着自己的性能和渲染补丁，不能跟着搬，所以这里放一层转发：新路径照旧能 import，
// 实际实现仍然只有一份（根目录那份）。等价于上游的搬家，只是搬的是路径而不是代码。
export * from '../loadPixi';
