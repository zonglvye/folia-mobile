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

const POLL_MS = 500;
const HOLD_MS = 800;
/** The hold only counts when it starts in this square of the top-left corner. */
const CORNER_PX = 64;

const fmt = (value: number, digits = 1) => value.toFixed(digits);

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
        const id = window.setInterval(() => {
            setStats(readFrameStats());
            readCap();
        }, POLL_MS);
        return () => window.clearInterval(id);
    }, [visible]);

    if (!visible) return null;

    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

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
                minWidth: 214,
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
            <div style={{ marginTop: 4, opacity: 0.4, fontSize: 9 }}>hold top-left corner to toggle</div>
        </div>
    );
};

export default React.memo(FrameStatsHud);
