// src/utils/appSplash.ts
// 控制 index.html 内联的首屏加载遮罩：React 挂载后淡出，动画结束再从 DOM 摘掉。

const SPLASH_ELEMENT_ID = 'app-splash';
// 与 index.html 中 #app-splash 的 transition 时长保持一致。
const FADE_OUT_MS = 320;

// 淡出并移除首屏加载遮罩；遮罩不存在（OBS 源已提前移除、或已经调用过）时是空操作。
export const hideAppSplash = (): void => {
    const splash = document.getElementById(SPLASH_ELEMENT_ID);
    if (!splash) {
        return;
    }
    splash.classList.add('is-hiding');
    window.setTimeout(() => splash.remove(), FADE_OUT_MS);
};

/**
 * 告诉打包壳「页面第一帧已经画好了」。
 *
 * 壳把原生启动动画画在 WebView 上面（鸿蒙 shell/StartupSplash、安卓 MainActivity 的遮罩），
 * 它自己判断不了 React 什么时候真正上屏，只能等这一句。没有桥时（浏览器、桌面版）是空操作。
 */
export const notifyShellFirstPaint = (): void => {
    const bridge = (window as { foliaAndroid?: { splashReady?: () => void } }).foliaAndroid;
    if (!bridge || typeof bridge.splashReady !== 'function') {
        return;
    }
    try {
        bridge.splashReady();
    } catch {
        // 旧壳没这个方法，或者桥已经销毁：启动动画那边有自己的兜底超时，这里不该抛出去。
    }
};
