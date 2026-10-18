import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
    EMPTY_FRAME_STATS,
    isFrameHudVisible,
    readFrameStats,
    resetFrameSamples,
    setFrameHudVisible,
    subscribeToFrameHud,
    type FrameStats,
} from '../services/debug/frameSamples';
import { parseVisualizerFrameRate, VISUALIZER_FRAME_RATE_STORAGE_KEY } from '../utils/frameRateLimiter';
import { countContextLosses, lastIncident, readIncidents } from '../services/debug/incidents';
import { describeAudioStart, readAudioStart } from '../services/playback/audioStartupProbe';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE } from '../types/visualizerModes';

// src/components/FrameStatsHud.tsx
// The only performance readout that works on the phone this app ships to.
//
// adb is not available there (see services/debug/frameSamples.ts for why), so the numbers have to be
// read off the screen. Toggled by holding the top-left corner for HOLD_MS: a phone in landscape has
// no keyboard, so the Alt+Shift+D chord that opens DevDebugOverlay is out of reach, and the corner
// hold is a gesture nothing else in the player claims.
//
// Polls at POLL_MS instead of subscribing to frames. Two updates a second is far below anything
// React notices, and it keeps the sampler's per-frame path free of React entirely.
//
// It also names what is on screen (visualizer mode, background mode, how the glow is drawn), because
// a frame-time reading only means something next to the layers that produced it: "30 fps in the
// visualizer" is a different bug with the shader background than without it, and the phone has no
// adb to look anything up on.

const POLL_MS = 500;
const HOLD_MS = 800;
/** The hold only counts when it starts in this square of the top-left corner. */
const CORNER_PX = 64;

const fmt = (value: number, digits = 1) => value.toFixed(digits);

/** Keeps a script name inside the panel: the interesting part is the prefix, not the chunk hash. */
const SCRIPT_LABEL_MAX = 26;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clipScriptLabel = (script: { name: string; file: string }, max: number) => (
    clip(script.file ? `${script.name} @ ${script.file}` : script.name, max)
);

const jankTone = (ms: number): string => {
    if (ms > 50) return '#fb7185';
    if (ms > 33.4) return '#fbbf24';
    return '#a3e635';
};

const Row: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ opacity: 0.55 }}>{label}</span>
        <span style={{ color: tone ?? '#f8fafc', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
);

const FrameStatsHud: React.FC = () => {
    const visible = useSyncExternalStore(subscribeToFrameHud, isFrameHudVisible);
    const [stats, setStats] = useState<FrameStats>(EMPTY_FRAME_STATS);
    const [frameCap, setFrameCap] = useState('off');
    /**
     * 崩溃证据。黑屏之后这台设备没有任何别的通道能说出发生过什么，所以把它和帧读数一起轮询：
     * `readIncidents()` 在没有新事件时返回同一个引用，这里不会产生多余的重渲染。
     */
    const [incidents, setIncidents] = useState(() => readIncidents());
    const visualizerMode = useVisualizerSettingsStore(state => state.visualizerMode);
    const backgroundMode = useVisualizerSettingsStore(state => state.visualizerBackgroundMode);
    const randomModePerSong = useVisualizerSettingsStore(state => state.randomVisualizerModePerSong);
    const glowOnCompositor = useVisualizerSettingsStore(state => state.glowBlurQuantize);

    // The corner hold. Registered at the window in the capture phase and never prevented, so the tap
    // that starts it still reaches whatever is underneath: this may not steal input from the player.
    useEffect(() => {
        let timer: number | null = null;
        const cancel = () => {
            if (timer !== null) {
                window.clearTimeout(timer);
                timer = null;
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (event.clientX > CORNER_PX || event.clientY > CORNER_PX) return;
            cancel();
            timer = window.setTimeout(() => {
                timer = null;
                setFrameHudVisible(!isFrameHudVisible());
            }, HOLD_MS);
        };
        const options: AddEventListenerOptions = { capture: true, passive: true };
        window.addEventListener('pointerdown', onPointerDown, options);
        window.addEventListener('pointerup', cancel, options);
        window.addEventListener('pointercancel', cancel, options);
        return () => {
            cancel();
            window.removeEventListener('pointerdown', onPointerDown, options);
            window.removeEventListener('pointerup', cancel, options);
            window.removeEventListener('pointercancel', cancel, options);
        };
    }, []);

    useEffect(() => {
        if (!visible) return undefined;
        const readCap = () => {
            try {
                setFrameCap(String(parseVisualizerFrameRate(window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY))));
            } catch {
                setFrameCap('unknown');
            }
        };
        readCap();
        setStats(readFrameStats());
        setIncidents(readIncidents());
        const id = window.setInterval(() => {
            setStats(readFrameStats());
            setIncidents(readIncidents());
            readCap();
        }, POLL_MS);
        return () => window.clearInterval(id);
    }, [visible]);

    if (!visible) return null;

    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const loaf = stats.loafWorst;
    const contextLosses = countContextLosses();
    const errorIncident = lastIncident('error') ?? lastIncident('rejection');
    const errorCount = incidents.filter(entry => entry.kind === 'error' || entry.kind === 'rejection').length;
    const blankRoot = lastIncident('blank-root');
    const audioStart = readAudioStart();

    return (
        <div
            style={{
                position: 'fixed',
                top: 8,
                left: 8,
                zIndex: 2147483000,
                padding: '8px 10px',
                borderRadius: 10,
                background: 'rgba(2, 6, 23, 0.82)',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                color: '#e2e8f0',
                font: '500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
                minWidth: 240,
                pointerEvents: 'auto',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ letterSpacing: '0.08em', opacity: 0.75 }}>FRAME</span>
                <span style={{ display: 'flex', gap: 6 }}>
                    <button
                        type="button"
                        onClick={() => resetFrameSamples()}
                        style={{ cursor: 'pointer', color: '#93c5fd', background: 'none', border: 0, font: 'inherit', padding: 0 }}
                    >
                        reset
                    </button>
                    {/* 屏黑了但界面还活着时，这是不卸载应用就能回到可用状态的唯一出口。 */}
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{ cursor: 'pointer', color: '#fcd34d', background: 'none', border: 0, font: 'inherit', padding: 0 }}
                    >
                        reload
                    </button>
                    <button
                        type="button"
                        onClick={() => setFrameHudVisible(false)}
                        style={{ cursor: 'pointer', color: '#fca5a5', background: 'none', border: 0, font: 'inherit', padding: 0 }}
                    >
                        close
                    </button>
                </span>
            </div>
            <Row label="fps" value={fmt(stats.fps)} tone={jankTone(1000 / Math.max(stats.fps, 0.01) / 2)} />
            <Row label="p50" value={`${fmt(stats.p50)} ms`} />
            <Row label="p90" value={`${fmt(stats.p90)} ms`} tone={jankTone(stats.p90)} />
            <Row label="p99" value={`${fmt(stats.p99)} ms`} tone={jankTone(stats.p99)} />
            <Row label="worst" value={`${fmt(stats.worst)} ms`} tone={jankTone(stats.worst)} />
            <Row label="jank" value={`${fmt(stats.jankRatio * 100)} %`} tone={jankTone(stats.p90)} />
            <Row label="frames" value={`${stats.frames} / ${fmt(stats.windowMs / 1000)}s`} />
            <Row label="longtasks" value={`${stats.longTaskCount} · max ${fmt(stats.longestTaskMs, 0)} ms`} />
            <Row label="heap" value={stats.heapMB === null ? 'n/a' : `${fmt(stats.heapMB, 0)} MB`} />
            <Row label="dpr / cap" value={`${fmt(dpr)} / ${frameCap}`} />
            <Row label="vis" value={`${visualizerMode}${randomModePerSong ? ' ·random' : ''}`} />
            <Row label="bg" value={backgroundMode ?? `${DEFAULT_VISUALIZER_BACKGROUND_MODE} (default)`} />
            <Row label="glow" value={glowOnCompositor ? 'compositor' : 'shadow'} />
            {/* 播放启动取证：连蓝牙耳机后「点播放毫无反应、进度条不动」时，这一行说明卡在哪个等待点。
                正常播放时就是 `resume:ok …` / `play:ok running`，不值得看。 */}
            <Row
                label="audio"
                value={describeAudioStart(audioStart)}
                tone={audioStart && audioStart.outcome !== 'ok' ? '#fb7185' : undefined}
            />
            {/* 黑屏那一类故障的证据：上下文丢失次数与最后一条异常。没有 adb 时，这两行就是全部线索。 */}
            <Row
                label="gl"
                value={`${contextLosses.lost} lost / ${contextLosses.restored} back`}
                tone={contextLosses.lost > 0 ? '#fb7185' : undefined}
            />
            <Row
                label="err"
                value={errorCount === 0 ? '0' : String(errorCount)}
                tone={errorCount > 0 ? '#fb7185' : undefined}
            />
            {blankRoot && <Row label="blank" value={`yes · ${fmt((Date.now() - blankRoot.at) / 1000, 0)}s ago`} tone="#fb7185" />}
            {errorIncident && (
                <div style={{ marginTop: 2, fontSize: 9, lineHeight: 1.35, opacity: 0.7, wordBreak: 'break-word' }}>
                    {clip(errorIncident.detail, 90)}
                </div>
            )}
            {loaf ? (
                <>
                    <Row
                        label="loaf"
                        value={`${stats.loafCount} · max ${fmt(loaf.worstMs, 0)} ms`}
                        tone={jankTone(loaf.worstMs)}
                    />
                    <Row
                        label="js·css·paint"
                        value={`${fmt(loaf.scriptMs, 0)} · ${fmt(loaf.styleAndLayoutMs, 0)} · ${fmt(loaf.renderMs, 0)}`}
                    />
                    {loaf.slowestScript && (
                        <Row label="slowest js" value={clipScriptLabel(loaf.slowestScript, SCRIPT_LABEL_MAX)} />
                    )}
                    {loaf.forcedStyleAndLayoutMs >= 1 && (
                        <Row label="forced layout" value={`${fmt(loaf.forcedStyleAndLayoutMs, 0)} ms`} />
                    )}
                </>
            ) : (
                <Row label="loaf" value="n/a" />
            )}
            {stats.stallSources.length > 0 && (
                <Row
                    label="block"
                    tone={jankTone(stats.stallSources[0].worstMs)}
                    value={`${clip(stats.stallSources[0].phase, 18)} ${fmt(stats.stallSources[0].worstMs, 0)} ms · ${stats.stallSources[0].count}x`}
                />
            )}
            <div style={{ marginTop: 4, opacity: 0.4, fontSize: 9 }}>hold top-left corner to toggle</div>
        </div>
    );
};

export default React.memo(FrameStatsHud);
