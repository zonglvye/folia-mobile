// src/utils/chunkLoadFailure.ts
// 「懒加载的那一块代码没拿到」长什么样。
//
// 它值得一个单独的判断，因为这种失败和普通异常不是一回事：chunk 的名字是内容哈希，包一更新旧的
// 名字就不存在了，所以唯一的正确处理是重载页面去拿新的那份，而不是把它当成一个渲染 bug 展示给
// 用户。措辞按引擎区分——Chromium 与 WebKit 各说各的，没有一个公共的说法。

const CHUNK_FAILURE_PATTERNS: readonly RegExp[] = [
    // Chromium / WebKit
    /failed to fetch dynamically imported module/i,
    // Firefox 与 Safari 的旧措辞
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    // 有的引擎把 404 直接报成「模块脚本 MIME 不对」
    /expected a javascript(?:orwasm)? module script/i,
];

export const isDynamicImportFailure = (message: string | null | undefined): boolean => {
    if (!message) return false;
    return CHUNK_FAILURE_PATTERNS.some(pattern => pattern.test(message));
};
