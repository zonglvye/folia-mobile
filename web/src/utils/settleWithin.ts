// src/utils/settleWithin.ts
// 给一个 promise 一个期限，并且把「成功 / 超时 / 失败」三种结局分开报出来。
//
// 与 navidromeServerPreset 里那个私有的 waitAtMost 不同：那个只关心拿到值没有，这里要的是「为什么没拿到」。
// 起因是安卓壳上音频启动会卡在永不决议的 promise 上（services/playback/audioStartupProbe 有完整说明）：
// 只有把超时和拒绝分开，才分得清是设备没响应还是真的报错。
//
// 超时不取消原 promise —— JS 没有取消，硬要等它自己结束。所以两条纪律：
//   · 返回的结局只是「这一刻的状态」，调用方想继续等就自己接原来的 promise；
//   · 原 promise 的两种结局都在这里被接管，超时之后它再拒绝也不会变成未处理的 rejection
//     （否则会被 installIncidentRecorders 的 unhandledrejection 记成一条事故，反而混淆取证的现场）。

export type SettleOutcome<T> =
    | { status: 'ok'; value: T }
    | { status: 'timeout' }
    | { status: 'rejected'; error: unknown };

/** 等 `promise` 最多 `timeoutMs` 毫秒；永不 reject。 */
export const settleWithin = async <T>(promise: Promise<T>, timeoutMs: number): Promise<SettleOutcome<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = promise.then(
        (value): SettleOutcome<T> => ({ status: 'ok', value }),
        (error): SettleOutcome<T> => ({ status: 'rejected', error }),
    );
    const deadline = new Promise<SettleOutcome<T>>(resolve => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });
    try {
        return await Promise.race([settled, deadline]);
    } finally {
        clearTimeout(timer);
    }
};
