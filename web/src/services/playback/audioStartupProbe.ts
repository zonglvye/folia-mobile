// src/services/playback/audioStartupProbe.ts
// 「按下播放之后，音频链路停在哪一步」的取证。
//
// 起因（2026-10 用户实测）：连上蓝牙耳机后点播放毫无反应、进度条不动；换回手机扬声器一切正常。
// `usePlaybackTransportController` 的 resumePlayback 只在 `audioContext.resume()` 与 `audio.play()`
// 两个 await 都决议之后才写 PLAYING，所以那个症状说明其中一个 promise 永不决议 —— 而这两个 await
// 既没有期限，也不留任何痕迹，出事时无处可查。
//
// 这里做的只是记账：帧率 HUD 的 `audio` 行读它。一次装机就能看出卡在哪个等待点、当时的 AudioContext
// 是不是 running、元素停在哪一个 readyState —— 「`ac: running` + `play: timeout`」和「`resume: timeout`」
// 指向完全不同的修法（前者是 Chromium 的音频输出起不来，后者是上下文拿不到输出流）。

export type AudioStartStep = 'resume' | 'play';
export type AudioStartOutcome = 'ok' | 'timeout' | 'rejected';

export type AudioStartReport = {
    step: AudioStartStep;
    outcome: AudioStartOutcome;
    /** 从按下播放到这一步有结局的毫秒数；超时的那一次就是这个期限本身。 */
    elapsedMs: number;
    /** 这一刻 AudioContext 的状态；没有上下文（还没建）记为 absent。 */
    contextState: AudioContextState | 'absent';
    /** 元素停在哪个 readyState / networkState（-1 = 当时没有元素）。 */
    readyState: number;
    networkState: number;
    errorName: string | null;
};

/**
 * 两个等待点的期限。都只是「多久之后算没响应」，不是「多久之后放弃」：
 * resume 慢一点没有关系（拖的只是启动），play 停在 4 秒说明音频链路确实没起来，
 * 但那之后它真的起来了照样要把界面补正（usePlaybackTransportController 的 timeout 分支）。
 */
export const AUDIO_START_TIMEOUT_MS = { resume: 1200, play: 4000 } as const;

let latest: AudioStartReport | null = null;

/** MediaError 只有数字码，读成名字才看得出是「格式不支持」还是「网络断了」。 */
const MEDIA_ERROR_NAMES: Readonly<Record<number, string>> = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

const describeMediaError = (element: HTMLAudioElement | null): string | null => {
    const code = element?.error?.code;
    return code ? (MEDIA_ERROR_NAMES[code] ?? `MEDIA_ERR_${code}`) : null;
};

export const buildAudioStartReport = (
    step: AudioStartStep,
    outcome: AudioStartOutcome,
    startedAt: number,
    context: AudioContext | null,
    element: HTMLAudioElement | null,
): AudioStartReport => ({
    step,
    outcome,
    elapsedMs: Math.round(performance.now() - startedAt),
    contextState: context ? context.state : 'absent',
    readyState: element?.readyState ?? -1,
    networkState: element?.networkState ?? -1,
    errorName: describeMediaError(element),
});

/** 记一步，给 HUD 读。 */
export const recordAudioStart = (
    step: AudioStartStep,
    outcome: AudioStartOutcome,
    startedAt: number,
    context: AudioContext | null,
    element: HTMLAudioElement | null,
): AudioStartReport => {
    latest = buildAudioStartReport(step, outcome, startedAt, context, element);
    return latest;
};

export const readAudioStart = (): AudioStartReport | null => latest;

export const clearAudioStart = (): void => {
    latest = null;
};

/** HUD 那一行的文案（纯函数，单测钉住）。正常时说「哪一步、成了」；不正常时把判断用的数字都带上。 */
export const describeAudioStart = (report: AudioStartReport | null): string => {
    if (!report) return 'idle';
    const parts: string[] = [`${report.step}:${report.outcome}`, report.contextState];
    if (report.outcome !== 'ok') {
        parts.push(`${report.elapsedMs} ms`, `rs ${report.readyState}/${report.networkState}`);
    }
    if (report.errorName) parts.push(report.errorName);
    return parts.join(' · ');
};
