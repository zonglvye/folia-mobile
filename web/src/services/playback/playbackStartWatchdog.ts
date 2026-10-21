// src/services/playback/playbackStartWatchdog.ts
// 「界面进了 PLAYING，却一点声音都没有」的取证 —— audioStartupProbe 补不上的那半边。
//
// 起因（2026-10 用户实测）：连蓝牙直接按播放时「没反应，也没跳任何东西」。上一版把超时线索挂在了
// play() 超时那一条分支上，可是这条路径根本走不到：AudioContext 停在 interrupted 时元素照样在走
// （play() 会决议、currentTime 在涨、进度条在动），只是节点图不推进 —— 于是既没有超时、也没有提示，
// 而声音是零。也就是说「有没有提示」这件事本身逼着我们去分辨两种沉默：
//
//   ctx:interrupted · el 3.2s  → 元素在走、context 不在 running：声音被 Web Audio 这一层卡住
//   el:stalled · ctx:running   → context 好好跑着，元素自己没动：解码 / 缓冲 / 源的问题
//
// 两者要改的地方完全不同，所以判定做成纯函数，单测钉住；读数只在播放真正起步后取一次。

/** 起步之后多久看一次。4s 的 play 期限在它之后，两条取证不会互相盖住。 */
export const PLAYBACK_START_WATCHDOG_MS = 1500;

/** currentTime 至少要走这么远才算「元素真的在走」：低于它分不清是没动还是刚开始。 */
export const PLAYBACK_POSITION_TOLERANCE_SEC = 0.12;

export type PlaybackStartVerdict =
    | { kind: 'ok' }
    | { kind: 'context-idle'; contextState: string; positionSec: number }
    | {
        kind: 'element-stalled';
        contextState: string;
        positionSec: number;
        /** 元素停在哪一档数据上：0/0 没有源、0/2 有源但一字节没到、2/2 有元数据在等流、4/2 有数据却没走。 */
        readyState: number;
        networkState: number;
        /** paused 为 true 说明是被谁按了暂停（元素在走就不会停）。 */
        paused: boolean;
        /** 这 1.5 秒里元素实际走了多远（秒，三位小数）。 */
        advanceSec: number;
    };

/**
 * 判一次：元素走了多远、context 在什么状态。
 *
 * 元素先判：没动的话 context 状态说什么都是次要的（哪怕 running 也出不来声音）。
 * context 记为 'absent'（还没建 Web Audio 图，声音走元素直出）不算问题。
 */
export const judgePlaybackStart = (input: {
    contextState: string;
    positionBeforeSec: number;
    positionNowSec: number;
    toleranceSec?: number;
    readyState?: number;
    networkState?: number;
    paused?: boolean;
}): PlaybackStartVerdict => {
    const toleranceSec = input.toleranceSec ?? PLAYBACK_POSITION_TOLERANCE_SEC;
    const positionSec = Math.round(input.positionNowSec * 10) / 10;
    const advanceSec = Math.max(0, input.positionNowSec - input.positionBeforeSec);
    if (advanceSec < toleranceSec) {
        return {
            kind: 'element-stalled',
            contextState: input.contextState,
            positionSec,
            readyState: input.readyState ?? -1,
            networkState: input.networkState ?? -1,
            paused: input.paused ?? false,
            advanceSec,
        };
    }
    if (input.contextState !== 'running' && input.contextState !== 'absent') {
        return { kind: 'context-idle', contextState: input.contextState, positionSec };
    }
    return { kind: 'ok' };
};

/** 那一行提示文案；没有任何问题时返回空串（调用处据此决定要不要弹）。 */
export const describePlaybackStart = (verdict: PlaybackStartVerdict): string => {
    switch (verdict.kind) {
        case 'context-idle':
            return `ctx:${verdict.contextState} · el ${verdict.positionSec.toFixed(1)}s`;
        // 这一行要在一屏里读完，所以只留判因要用的数：数据档位 / 网络档位 / 有没有被暂停 / 走了多远。
        case 'element-stalled':
            return `el:stalled · rs ${verdict.readyState}/${verdict.networkState} · p ${verdict.paused ? 1 : 0} · +${verdict.advanceSec.toFixed(2)}s`;
        default:
            return '';
    }
};
