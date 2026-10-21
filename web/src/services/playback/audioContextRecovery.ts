// src/services/playback/audioContextRecovery.ts
// 把被系统收走的 AudioContext 拉回来的两条通道（Android WebView 上蓝牙耳机反复失效的那个问题）。
//
// 背景：蓝牙路由切换、来电、别的应用抢音频焦点之后，Chromium 会把 AudioContext 停在非 running 状态。
// 安卓上是 'interrupted'，桌面上常见 'suspended'。这个状态的后果比「没声音」更糟：节点图不推进，
// 而挂进图的 <audio> 元素被它一起拖着 —— play() 永不决议、currentTime 不走，界面上就是
// 「按了播放毫无反应、进度条不动」。
//
// 0.6.5 只给 resume() 加了 1.2s 期限（避免它不决议时整段卡住），但调用处只判断 state === 'suspended'，
// 停在 'interrupted' 时一次 resume 都不会发，那条兜底也就无从触发。这里补两条通道：
// - 任何一次用户手势（指针按下 / 按键）都试一次。安卓上这是唯一稳定可靠的时机，而用户此刻正在点「播放」；
// - 状态自己掉出 running（播放中被路由切换、被来电打断）时补一次迟到的重试，免得必须再点一下。
//
// 都尽量安静：running 时只是一次属性读取就返回，不改状态、不打日志、不排队。
//
// 有一条**已经撤回**的改动记在这里（2026-10，0.6.12）：0.6.8 曾给安卓壳显式开
// `sampleRate: 48000` + `latencyHint: 'playback'`，理由是「A2DP 只给 48k，默认 44.1k 开不到蓝牙 sink 上」。
// 那个推断是错的：真机后来的读数（`el:stalled · rs 4/1 · p 0 · +0.00s`，context 报 running 而元素时钟
// 一动不动）指向的正是「context 假 running」——取样率由调用方硬点，是当时唯一被自己引进这条路径的变量。
// 现在回到平台默认：`new AudioContext()`，一个参数都不传（见 usePlaybackAudioBridge 的注释）。

/** 只有 running 才是「音频真的在走」。'suspended' / 'interrupted'（安卓）/ 'closed' 都要重新拉。 */
export const needsAudioResume = (state: AudioContextState | string): boolean => state !== 'running';

/**
 * 「假 running」：state 说 running，但音频渲染线程并没有在拉元素。
 *
 * 判据只能从元素身上取：data 齐了（readyState ≥ 2）、没人暂停（paused === false），
 * 而 currentTime 在这段时间里一米都没走。三者同时成立时，节点图再报 running 也不算数。
 */
export const isAudioContextZombie = (element: HTMLAudioElement | null): boolean => (
    Boolean(element) && element!.readyState >= 2 && !element!.paused
);

/**
 * 把「假 running」的 context 救一次：suspend → resume。Chromium 借这一次会关掉再重开输出流，
 * 死去的那条音频渲染线程通常就这么回来了。返回是否发出去了（能不能救回来由调用方再测一次时钟）。
 */
export const bounceAudioContext = async (context: AudioContext | null): Promise<boolean> => {
    if (!context) return false;
    try {
        await context.suspend();
    } catch {
        // suspend 被打断无所谓，下面照样 resume。
    }
    try {
        await context.resume();
        return true;
    } catch {
        return false;
    }
};

/** 掉出 running 之后多久补一次重试：给系统把路由切完的时间。只补一次，不和平台抢。 */
const STATE_RETRY_DELAY_MS = 400;

/** 同一个 context 只装一次（StrictMode 下 setup 会跑两遍，setupAudioAnalyzer 自己也只建一次）。 */
const watched = new WeakSet<AudioContext>();

/**
 * 给这个 context 装上「手势唤醒 + 状态重试」。幂等：同一个 context 重复调用无副作用。
 *
 * 会占用 context.onstatechange（当前没有别处用它；以后要用就改成一个订阅表）。
 */
export const keepAudioContextAwake = (context: AudioContext): void => {
    if (typeof window === 'undefined') return;
    if (watched.has(context)) return;
    watched.add(context);

    const awake = () => {
        if (!needsAudioResume(context.state)) return;
        void context.resume().catch(() => {
            // 拉不起来就算了：下一次手势、或者元素自己的失败路径会再走一遍，这里不做重试风暴。
        });
    };

    // 捕获阶段 + passive：不拦事件、不改任何事件的走向，这一层只在旁边看。
    window.addEventListener('pointerdown', awake, { capture: true, passive: true });
    window.addEventListener('keydown', awake, { capture: true, passive: true });

    let retry: ReturnType<typeof setTimeout> | null = null;
    context.onstatechange = () => {
        if (retry !== null) {
            clearTimeout(retry);
            retry = null;
        }
        if (!needsAudioResume(context.state)) return;
        retry = setTimeout(() => {
            retry = null;
            awake();
        }, STATE_RETRY_DELAY_MS);
    };
};
