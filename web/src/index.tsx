import { Buffer } from 'buffer';
import { ensureVisualizerFrameRateDefault, installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { isAndroidShell } from './utils/platform';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installShellFetchProxy } from './services/shellFetchProxy';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
// 手机壳上首启默认 60 帧：没有这道闸时每个 draw loop 都跟着屏幕刷新率跑，120Hz 机器上
// 可视化器和网格过场就是两倍的帧、两倍的开销。用户在图形设置里改过就永远听用户的。
if (isAndroidShell()) {
    ensureVisualizerFrameRateDefault(60);
}
installGlobalVisualizerFrameRateLimiter();

// 鸿蒙壳把同源代理做成了异步桥方法（ArkWeb 的拦截回调是同步的，拿不到上游数据）。
// 有桥就把 fetch 接过去；浏览器 / 桌面 / 安卓壳没有这个方法，这一步什么也不做。
// 必须在 bootstrap 之前装：provider 的第一次请求就在启动阶段。
installShellFetchProxy();

// ---- service worker 策略 -------------------------------------------------------------
// 手机壳里**不注册** service worker，并且把以前注册过的那份清掉。
//
// 这不是省事：壳的离线本来就是结构性的（产物在 APK 里），SW 在这里没有一件事可做，却能出错。
// 实机上抓到的那次黑屏就是它造成的：旧版本的 SW 把旧的 index.html 留在 precache 里，装上
// 新版本之后那份旧 HTML 仍然引用旧哈希的 chunk（`BravaisCollection-Cys-1Rmu.js`），而那个
// 文件在新 APK 里已经不存在了 —— 懒加载 404 → 未捕获异常 → React 卸载整棵树 → 黑屏。
// 网页形态下同一份旧 HTML 没事（旧文件还在服务器上），所以这个坑只在壳里致命。
const retireBundledServiceWorker = () => {
    try {
        if ('serviceWorker' in navigator) {
            void navigator.serviceWorker.getRegistrations()
                .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
                .catch(() => { /* 拿不到注册列表就算了，不影响启动 */ });
        }
        if (typeof caches !== 'undefined') {
            // 只删 workbox 自己的缓存：别的 Cache Storage 归属别的功能，不该跟着一起没。
            void caches.keys()
                .then(keys => Promise.all(keys.filter(key => key.startsWith('workbox-')).map(key => caches.delete(key))))
                .catch(() => { /* 同上 */ });
        }
    } catch {
        // 隐私模式等：没有 SW 就没有这个问题。
    }
};

if (isAndroidShell()) {
    retireBundledServiceWorker();
} else if ('serviceWorker' in navigator) {
    void import('virtual:pwa-register')
        .then(({ registerSW }) => registerSW({ immediate: true }))
        .catch(() => { /* 注册失败只是没有离线缓存，不该影响启动 */ });
}

void import('./bootstrap');
