// src/services/playbackRecovery/networkReconnect.ts
// 断网重连：网络恢复（window 的 `online` 事件）后，自动重试因此停下来的那次播放。
//
// 为什么需要：网络断开时 `<audio>` 会拿到 MEDIA_ERR_NETWORK，或音源请求直接失败，播放器按策略停播并给出
// 「重试 / 跳过」。此前网络恢复后没有任何东西会再试一次，用户只能自己点「重试」——真机实测断网再恢复，
// 播放会一直停在那里。这里把「恢复后要做什么」登记下来，`online` 一到就执行。
//
// 只处理**网络类**失败（network / timeout）：登录、会员、地区这些重试不会变好，交给用户决定。
// `isCurrent` 由调用方给，歌曲已切换或重新点播时旧任务什么都不做。

export type NetworkRetry = {
    /** 执行重试；由调用方包好（会先收起失败消息）。 */
    run: () => void;
    /** 这次失败是否仍属于当前播放：歌曲没换、也重新点播过。 */
    isCurrent: () => boolean;
    /**
     * 优先级：点歌失败（用户刚点了下一首/某首歌）高于播放中媒体元素失败。
     * 断网时点「下一首」，旧元素也会顺带报 MEDIA_ERR_NETWORK；没有这个优先级，
     * 后登记的旧元素会盖掉用户真正想要的那次重试，恢复后播回上一首。
     */
    priority?: number;
};

/** 网络恢复后等一小会儿再重试：刚拿到地址时 DNS/连接常还没就绪。 */
const ONLINE_RETRY_DELAY_MS = 800;

let pending: NetworkRetry | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let restoredSinceLastCheck = false;

/** 当前是否明确离线。`navigator.onLine` 只在平台给出确定答案时才是 false。 */
export const isNetworkOffline = (): boolean => (
    typeof navigator !== 'undefined' && navigator.onLine === false
);

/** 登记一次「网络恢复后自动重试」。同一时刻只留最后一次失败，低优先级不能盖掉高优先级。 */
export const registerNetworkRetry = (retry: NetworkRetry): void => {
    const nextPriority = retry.priority ?? 1;
    const pendingPriority = pending?.priority ?? 1;
    if (pending && nextPriority < pendingPriority) return;
    pending = retry;
};

/** 取消登记（用户重试 / 跳过 / 换歌 / 换成非网络类失败时调用）。 */
export const clearNetworkRetry = (): void => {
    pending = null;
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
};

/**
 * 自上次调用以来网络是否恢复过。
 *
 * 音源刷新的去重（同一媒体文件只刷新一次）在网络恢复后要让一次：断网期间刷新过的那次不能把恢复后的
 * 第一次刷新也挡掉。调用即消费。
 */
export const consumeNetworkRestored = (): boolean => {
    if (!restoredSinceLastCheck) return false;
    restoredSinceLastCheck = false;
    return true;
};

/** 装上 `online` / `offline` 监听；幂等，应用启动时调一次。 */
export const installNetworkReconnect = (): void => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    window.addEventListener('online', () => {
        restoredSinceLastCheck = true;
        const retry = pending;
        if (!retry) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            // 期间用户点了重试/跳过，或换了一首歌：登记已不是这一条，什么都不做。
            if (pending !== retry) return;
            pending = null;
            if (retry.isCurrent()) retry.run();
        }, ONLINE_RETRY_DELAY_MS);
    });

    window.addEventListener('offline', () => {
        // 离线时不重试，等下一次 online；已排的时间也不用留着。
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    });
};
