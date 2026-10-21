import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { PlayerState } from '../types';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setPlayerState } from '../stores/usePlaybackStore';
import { useTranslation } from 'react-i18next';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { currentTime } from '../stores/motionSignals';
import { markProgrammaticPause, playbackFade, type PlaybackFadeSettleReason } from '../services/playbackFade';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { getPlaybackFailureMessage, isPlaybackFailureStatus } from '../services/playbackRecovery/playbackFailurePolicy';
import type { OnlineRecoveryOptions, OnlineRecoveryResult, PlaybackFailure } from '../types/playbackFailure';
import { AUDIO_START_TIMEOUT_MS, describeAudioStart, readAudioStart, recordAudioStart } from '../services/playback/audioStartupProbe';
import { PLAYBACK_START_WATCHDOG_MS, PLAYBACK_POSITION_TOLERANCE_SEC, describePlaybackStart, judgePlaybackStart } from '../services/playback/playbackStartWatchdog';
import { bounceAudioContext, isAudioContextZombie, needsAudioResume } from '../services/playback/audioContextRecovery';
import { settleWithin } from '../utils/settleWithin';

// src/hooks/usePlaybackTransportController.ts

type UsePlaybackTransportControllerParams = {
    stageActiveEntryKind: string | null;
    isNowPlayingStageActive: boolean;
    audioRef: RefObject<HTMLAudioElement | null>;
    audioContextRef: MutableRefObject<AudioContext | null>;
    stageLyricsClockRef: MutableRefObject<{
        startTimeSec: number;
        endTimeSec: number;
        baseTimeSec: number;
        startedAtMs: number | null;
    }>;
    setupAudioAnalyzer: () => void;
    syncOutputGain: (targetVolume: number, smoothing?: number) => void;
    getTargetPlaybackVolume: () => number;
    shouldRefreshCurrentOnlineAudioSource: () => boolean;
    recoverOnlinePlaybackSource: (options: OnlineRecoveryOptions) => Promise<OnlineRecoveryResult>;
    getSyntheticStageLyricsTime: () => number;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    /**
     * Handles a pause that lands during an automix blend, returning true when it did.
     *
     * Mid-blend `audioRef` names the deck the next track is ARRIVING on, so the pause below would
     * stop a deck the listener cannot hear and leave the one they can hear playing on into the
     * next song - "I pressed pause and it jumped to the next track". This cancels the blend back
     * onto the deck still sounding the displayed track and pauses that, the same cancel a mid-blend
     * seek uses. Returns false (and the ordinary pause runs) when no blend is in flight.
     */
    pauseDuringTransition?: () => boolean;
    /** True while a blend is audible on the deck no control points at. Such a pause still needs the fade. */
    isTransitionAudible?: () => boolean;
};

// Owns play and pause transport behavior across main playback and Stage lyric-only playback.
export function usePlaybackTransportController({
    stageActiveEntryKind,
    isNowPlayingStageActive,
    audioRef,
    audioContextRef,
    stageLyricsClockRef,
    setupAudioAnalyzer,
    syncOutputGain,
    getTargetPlaybackVolume,
    shouldRefreshCurrentOnlineAudioSource,
    recoverOnlinePlaybackSource,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    pauseDuringTransition,
    isTransitionAudible,
}: UsePlaybackTransportControllerParams) {
    // Read here rather than passed in: store fields, a module-level motion signal, or i18n.
    const { t } = useTranslation();
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const duration = usePlaybackStore(state => state.duration);
    const transportRevision = useRef(0);
    const wantsPlayback = useRef(false);
    // 起步观测的那一次读数（playbackStartWatchdog）。每次按键先撤掉上一次的，免得两条提示互相盖。
    const startWatchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearStartWatchdog = useCallback(() => {
        if (startWatchdogTimer.current === null) return;
        clearTimeout(startWatchdogTimer.current);
        startWatchdogTimer.current = null;
    }, []);
    useEffect(() => () => {
        transportRevision.current++;
        wantsPlayback.current = false;
        clearStartWatchdog();
    }, [clearStartWatchdog]);

    const resumePlayback = useCallback(async () => {
        if (isNowPlayingStageActive) {
            return;
        }
        const revision = ++transportRevision.current;
        wantsPlayback.current = true;
        // 上一次按键留下的起步观测作废（它自己也认 revision，这里只是不白留一个定时器）。
        clearStartWatchdog();

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PLAYING, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PLAYING);
            return;
        }

        // A pause still fading out never reached the element, so there is nothing to start: turn
        // the fade around from the current gain instead of pressing play. A deck the export
        // controller already paused by hand takes the normal path below, which also retires the
        // pending pause.
        if (
            playbackFade.isFadingOut()
            && (!audioRef.current?.paused || isTransitionAudible?.())
            && playbackFade.cancelPendingPause()
        ) {
            setPlayerState(PlayerState.PLAYING);
            return;
        }

        const audio = audioRef.current;
        if (!audio) {
            return;
        }
        // A pause does not cancel source loading, but it must cancel an older
        // asynchronous resume. Store notifications alone cannot identify that
        // stale PLAYING event once a caller has already observed PAUSED.
        const source = usePlaybackStore.getState().audioSrc;
        const isSameSource = () => audioRef.current === audio && usePlaybackStore.getState().audioSrc === source;
        const isCurrent = () => revision === transportRevision.current && isSameSource();
        // A pending refresh can still supply the source after a pause. Its autoplay
        // decision follows the latest transport intent, including a later resume.
        const shouldAutoplay = () => wantsPlayback.current && isSameSource();

        setupAudioAnalyzer();
        // 两个 await 都带期限（audioStartupProbe 里有完整的来龙去脉）：它们可以永不决议，而这个函数的
        // 第一行状态写入就在它们后面，卡住时界面上只表现为「按了没反应」。超时不取消原 promise。
        const startedAt = performance.now();
        const context = audioContextRef.current;
        // 只要不是 running 就拉。安卓上被系统收走（蓝牙路由切换 / 来电 / 别的应用抢焦点）的 context 停在
        // 'interrupted' 而不是 'suspended'，只判断后者会一次 resume 都不发：节点图不推进，挂进来的 <audio>
        // 也被拖着，play() 永不决议、进度条不动 —— 蓝牙耳机那个「按了没反应」正是这条路径。
        if (context && needsAudioResume(context.state)) {
            const resumed = await settleWithin(context.resume(), AUDIO_START_TIMEOUT_MS.resume);
            recordAudioStart('resume', resumed.status, startedAt, context, audio);
            if (resumed.status === 'rejected') {
                if (!isCurrent()) return;
                throw resumed.error;
            }
        }
        if (!isCurrent()) return;

        syncOutputGain(getTargetPlaybackVolume(), 0);
        // A failed TTL refresh still falls back to the old URL below, as before. Its reason is kept
        // so that, should that play fail too, the message names it rather than a generic error.
        let refreshFailure: PlaybackFailure | null = null;
        if (shouldRefreshCurrentOnlineAudioSource()) {
            const refreshed = await recoverOnlinePlaybackSource({
                failedSrc: audio.currentSrc || audioSrc,
                resumeAt: audio.currentTime,
                autoplay: true,
                shouldAutoplay,
            });

            if (!isCurrent() || refreshed.status === 'recovered') {
                return;
            }
            refreshFailure = refreshed.status === 'failed' ? refreshed.failure : null;
        }

        // Silent first, ramped up once play() has really started. Null when the fade is off or
        // there is no Web Audio graph, and the two calls below are then no-ops. Only for an element
        // that is actually stopped: pressing play on one that is already sounding must not dip it.
        const fadeToken = audio.paused || audio.ended
            ? playbackFade.prepareFadeIn()
            : null;

        // 元素里没有任何音源时 play() 按规范永不决议 —— 等 4 秒、没有声音、也没有任何线索
        // （真机抓到的正是 `play:timeout · running · rs 0/0`：按下播放 4 秒后元素还是空的）。
        // 三种情形分开处理：store 里有地址 → 补进元素；没有任何地址但歌是在线的 → 现取一次（按播放本来就
        // 是「请你再试一次」的手势，取到了就接着放、取不到就把分类后的原因说清楚）；其余 → 说明白，不再白等。
        if (!audio.currentSrc && !audio.getAttribute('src')) {
            const storeSrc = usePlaybackStore.getState().audioSrc;
            if (storeSrc) {
                audio.src = storeSrc;
                audio.load();
            } else {
                // autoplay: false —— 这一趟只负责把音源取回来，起播由下面这段继续，免得两处同时按 play。
                const recovered = await recoverOnlinePlaybackSource({
                    force: true,
                    autoplay: false,
                    resumeAt: audio.currentTime,
                    failedSrc: null,
                    shouldAutoplay: isCurrent,
                });
                if (!isCurrent()) return;
                const recoveredSrc = recovered.status === 'recovered' ? usePlaybackStore.getState().audioSrc : null;
                if (recoveredSrc) {
                    // 直接写进元素：React 的提交还没到，等它就又是同一次白等。
                    audio.src = recoveredSrc;
                    audio.load();
                } else {
                    playbackFade.abortFadeIn(fadeToken);
                    const failure = recovered.status === 'failed' ? recovered.failure : null;
                    const failureMessage = failure ? getPlaybackFailureMessage(failure) : null;
                    // 在线的取不到就把分类后的原因（网络 / 版权 / 需要登录）说出来；本地、Navidrome、
                    // stage 那几档走不到重取，报出「压根没有音源」这个事实加当时的播放状态。
                    const text = failureMessage
                        ? (failureMessage.params ? t(failureMessage.key, failureMessage.params) : t(failureMessage.key))
                        : `src:missing · ${usePlaybackStore.getState().playerState}`;
                    setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : { type: 'error', text }));
                    setPlayerState(PlayerState.PAUSED);
                    return;
                }
            }
        }

        try {
            // play() 按规范在真正开始播放时才决议，所以「一直不决议」就是音频链路没起来 —— 安卓壳上
            // 连蓝牙耳机时正是这个表现。给它一个期限只为两件事：把结局记进 audioStartupProbe（诊断用），
            // 以及在它迟到地起来时把界面补正（否则这一页就永久停在「按了没反应」）。
            const playPromise = audio.play();
            const played = await settleWithin(playPromise, AUDIO_START_TIMEOUT_MS.play);
            recordAudioStart('play', played.status, startedAt, context, audio);
            if (played.status === 'rejected') throw played.error;
            if (played.status === 'timeout') {
                // 元素没起来，而 context 也不在 running：多半是它拖着元素。补发一次（手势通道在
                // audioContextRecovery 里，这里只管这一次）。
                if (context && needsAudioResume(context.state)) void context.resume().catch(() => {});
                // 卡在这一步时界面上原本什么也没有（状态还是 PAUSED，进度条不动），而这台设备没有 adb，
                // 屏幕是唯一的取证通道。把 audioStartupProbe 的结论直接示出来：
                // `play:timeout · suspended · 4000 ms · rs 4/2` 就说明了卡在哪一步、context 停在什么状态。
                const report = describeAudioStart(readAudioStart());
                if (report) setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : { type: 'error', text: report }));
                void playPromise.then(() => {
                    if (!isCurrent()) {
                        playbackFade.abortFadeIn(fadeToken);
                        return;
                    }
                    playbackFade.runFadeIn(fadeToken);
                    setPlayerState(PlayerState.PLAYING);
                    setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? null : prev));
                }).catch(() => {
                    // 迟到的拒绝：界面状态上面已经不再动它（元素自己的 onError 会走既有的失败路径），
                    // 只把结局改记成 rejected，诊断记录才不是一直写着「超时」。
                    recordAudioStart('play', 'rejected', startedAt, context, audio);
                });
                return;
            }
            if (!isCurrent()) { playbackFade.abortFadeIn(fadeToken); return; }
            // 元素起来了但 context 还不在 running：进度会走而没有声音，这里再唤醒一次（跑完就返回，不影响正常路径）。
            if (context && needsAudioResume(context.state)) void context.resume().catch(() => {});
            playbackFade.runFadeIn(fadeToken);
            setPlayerState(PlayerState.PLAYING);
            // 「元素在走、却没有声音」这一档上面两条提示都抓不到（play() 已经决议了，没有超时也没有拒绝），
            // 而它正是蓝牙那条路径上的表现：context 停在 interrupted，元素照常推进、界面照常进 PLAYING，
            // 于是既没提示也没声音。起步后看一眼读数，把结论直接示出来（playbackStartWatchdog 的文件头）。
            clearStartWatchdog();
            const positionAtStart = audio.currentTime;
            startWatchdogTimer.current = setTimeout(() => {
                startWatchdogTimer.current = null;
                if (!isCurrent()) return;
                const element = audioRef.current;
                const verdict = judgePlaybackStart({
                    contextState: context ? context.state : 'absent',
                    positionBeforeSec: positionAtStart,
                    positionNowSec: element?.currentTime ?? -1,
                    readyState: element?.readyState ?? -1,
                    networkState: element?.networkState ?? -1,
                    paused: element?.paused ?? true,
                });
                const text = describePlaybackStart(verdict);
                if (!text) return;
                // 同一行也写进会话日志（设置 → 开发者 → 运行日志），这样截日志也能取证，不必只靠提示。
                console.warn(`[Playback] start watchdog: ${text} (src ${(element?.currentSrc || element?.getAttribute('src') || 'none').slice(0, 64)})`);
                setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : { type: 'error', text }));
                // 「假 running」：数据齐、没人暂停、时钟却不动 —— 音频渲染线程没在拉这个元素。
                // 救一次（suspend → resume 会让 Chromium 关掉再重开输出流），再测一次时钟；
                // 救活了就把提示收掉，救不活就把结论改成带后续标记的那一版。
                if (verdict.kind === 'element-stalled' && isAudioContextZombie(element)) {
                    void bounceAudioContext(context).then(() => {
                        const resample = setTimeout(() => {
                            startWatchdogTimer.current = null;
                            if (!isCurrent()) return;
                            const revived = (audioRef.current?.currentTime ?? 0) > positionAtStart + PLAYBACK_POSITION_TOLERANCE_SEC;
                            console.warn(`[Playback] context bounce: ${revived ? 'revived' : 'still frozen'}`);
                            if (revived) {
                                setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : null));
                                return;
                            }
                            // 救不回来 = 这台机器的 Web Audio 确实拉不动元素（鸿蒙 NEXT 的 ArkWeb 就是这样：
                            // 连纯 Web Audio 的测试页都没有声音）。把直出模式记下来 —— 下一次启动就不建图，
                            // 声音走 <audio> 直出。代价（没有可视化/均衡/淡入淡出）比不上完全没有声音。
                            // 开关只在建图之前有效，所以这里只能写入、不能当场切换，提示用户重启。
                            useAudioSettingsStore.getState().handleToggleDirectOutput(true);
                            console.warn('[Playback] context revival failed; direct output mode enabled for the next launch');
                            setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : { type: 'error', text: t('options.directOutputRestartHint') }));
                        }, PLAYBACK_START_WATCHDOG_MS);
                        startWatchdogTimer.current = resample;
                    });
                }
            }, PLAYBACK_START_WATCHDOG_MS);
            // Playback is back, so a leftover playback-failure toast goes too: its two buttons are
            // retry and skip, with no close control. Countdowns and every other toast stay.
            setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? null : prev));
        } catch (error) {
            playbackFade.abortFadeIn(fadeToken);
            if (!isCurrent()) return;
            const recovered = await recoverOnlinePlaybackSource({
                failedSrc: audio.currentSrc || audioSrc,
                resumeAt: audio.currentTime,
                autoplay: true,
                shouldAutoplay,
            });

            if (!isCurrent() || recovered.status === 'recovered') {
                return;
            }

            if (!audio.paused && !audio.ended) {
                setPlayerState(PlayerState.PLAYING);
                return;
            }

            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                setStatusMsg({ type: 'info', text: t('status.clickToPlay') });
                setPlayerState(PlayerState.PAUSED);
                return;
            }

            const failure = recovered.status === 'failed' ? recovered.failure : refreshFailure;
            const failureMessage = failure ? getPlaybackFailureMessage(failure) : null;
            const text = failureMessage
                ? (failureMessage.params ? t(failureMessage.key, failureMessage.params) : t(failureMessage.key))
                : t('status.playbackError');
            // 已有带「重试 / 跳过」的常驻失败提示时保留它：它已写明原因，而且没有关闭按钮，「重试」是唯一的强制刷新入口。
            // 在出错的元素上按播放（play() 以 NotSupportedError 拒绝、刷新被按文件去重）或与 onError 共用同一个恢复任务时，
            // 这条 3 秒后消失的提示都会把它连同按钮一起盖掉。
            setStatusMsg(prev => (isPlaybackFailureStatus(prev) ? prev : { type: 'error', text }));
            setPlayerState(PlayerState.PAUSED);
            throw error;
        }
    }, [activePlaybackContext, audioContextRef, audioRef, audioSrc, clearStartWatchdog, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, isTransitionAudible, recoverOnlinePlaybackSource, setPlayerState, setStatusMsg, setupAudioAnalyzer, shouldRefreshCurrentOnlineAudioSource, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock, t]);

    const pausePlayback = useCallback(() => {
        if (isNowPlayingStageActive) {
            return;
        }
        transportRevision.current++;
        wantsPlayback.current = false;
        clearStartWatchdog();

        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            const currentSyntheticTime = getSyntheticStageLyricsTime();
            syncStageLyricsClock(currentSyntheticTime, duration, PlayerState.PAUSED, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(currentSyntheticTime);
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        const readCurrentSongKey = () => {
            const song = usePlaybackStore.getState().currentSong;
            return song ? getPlaybackSongKey(song) : null;
        };
        const songKeyAtPress = readCurrentSongKey();

        // Before the element is touched, because mid-blend `audioRef` is the wrong element to touch:
        // it names the deck the next track is arriving on. The cancel pauses the deck that is
        // actually sounding, so there is nothing left here but to settle the transport.
        // Returns whether a pause happened, so the caller knows to settle the transport.
        const settlePause = (reason: PlaybackFadeSettleReason = 'elapsed'): boolean => {
            if (pauseDuringTransition?.()) {
                // The cancel left the audio ref on the deck it just paused, and that deck's pause
                // event is as much a flush's as the plain path's below.
                if (reason === 'flushed' && audioRef.current) {
                    markProgrammaticPause(audioRef.current);
                }
                syncOutputGain(getTargetPlaybackVolume(), 0);
                return true;
            }

            if (!audioRef.current) {
                return false;
            }

            // A flush happens while a track change is in flight: its pause event arrives after the
            // new song has set its play intent, so it is marked and ignored by the pause handler.
            if (reason === 'flushed' && !audioRef.current.paused && !audioRef.current.ended) {
                markProgrammaticPause(audioRef.current);
            }
            audioRef.current.pause();
            syncOutputGain(getTargetPlaybackVolume(), 0);
            return true;
        };

        // Fade first, pause when the ramp is done. The whole of settlePause is deferred, so a
        // blend that is armed or running at that moment is still cancelled onto the right deck.
        // The transport reads PAUSED straight away; the element follows ~200ms later. Nothing to
        // fade (already paused, feature off, no Web Audio) pauses directly as before.
        const transitionAtPress = Boolean(isTransitionAudible?.());
        const isSounding = Boolean(audioRef.current && !audioRef.current.paused) || transitionAtPress;
        // Backstop for song changes that bypass playSong's own flush: a different song by the time
        // the fade ends means the pause was meant for the old one, and the new one must keep playing.
        // Not applied during a blend: an armed blend has already asked for the next song, so
        // `currentSong` moves to it a moment after the press without that being a change of mind -
        // and the pause still has to cancel the blend back onto the song the listener was hearing.
        const settleDeferredPause = (reason: PlaybackFadeSettleReason) => {
            const duringBlend = transitionAtPress || Boolean(isTransitionAudible?.());
            if (!duringBlend && readCurrentSongKey() !== songKeyAtPress) return;
            settlePause(reason);
        };
        if (isSounding && playbackFade.fadeOutThen(settleDeferredPause)) {
            setPlayerState(PlayerState.PAUSED);
            return;
        }

        if (settlePause()) {
            setPlayerState(PlayerState.PAUSED);
        }
    }, [activePlaybackContext, audioRef, audioSrc, clearStartWatchdog, currentTime, duration, getSyntheticStageLyricsTime, getTargetPlaybackVolume, isNowPlayingStageActive, isTransitionAudible, pauseDuringTransition, setPlayerState, stageActiveEntryKind, stageLyricsClockRef, syncOutputGain, syncStageLyricsClock]);

    return {
        resumePlayback,
        pausePlayback,
    };
}
