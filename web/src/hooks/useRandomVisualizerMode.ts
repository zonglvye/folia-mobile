import { useEffect, useRef } from 'react';
import type { SongResult, VisualizerMode } from '../types';
import { pickRandomVisualizerMode } from '../utils/randomVisualizerModes';
import type { SetVisualizerModeOptions } from '../stores/useVisualizerSettingsStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

// Applies a different registered lyric animation mode when the active track changes.
//
// 上游 v0.7.22 的版本：抽签池从设置里来（modes），而不是全库随机。三条规则都在下面：
//   1. 一首歌只抽一次 —— 同一首歌里刷新元数据、StrictMode 重跑都不会重抽。
//   2. 打开随机、或者改了池子时，只有当当前样式不在池子里才换（免得刚勾完就跳样式）。
//   3. 抽签自己切样式时带 preserveRandom，否则 handleSetVisualizerMode 会把随机关掉。
export function useRandomVisualizerMode({
    currentSong,
    enabled,
    visualizerMode,
    modes,
    setVisualizerMode,
}: {
    currentSong: SongResult | null;
    enabled: boolean;
    visualizerMode: VisualizerMode;
    modes: readonly VisualizerMode[];
    setVisualizerMode: (mode: VisualizerMode, options?: SetVisualizerModeOptions) => void;
}) {
    const observedSongIdRef = useRef<string | null>(null);
    const pendingChoiceRef = useRef<{ songId: string | null; from: VisualizerMode; modes: readonly VisualizerMode[] } | null>(null);

    useEffect(() => {
        const songId = currentSong ? getPlaybackSongKey(currentSong) : null;
        if (!enabled) {
            observedSongIdRef.current = songId;
            pendingChoiceRef.current = null;
            return;
        }
        const songChanged = songId !== null && observedSongIdRef.current !== null && observedSongIdRef.current !== songId;
        if (songId !== null) observedSongIdRef.current = songId;

        // Keep one choice for the whole song. Enabling random or editing its pool only replaces a
        // style that is outside the selection; StrictMode and refreshed song metadata do not reroll.
        if (!songChanged && modes.includes(visualizerMode)) {
            pendingChoiceRef.current = null;
            return;
        }
        // StrictMode can replay this effect before the selected mode reaches the next render.
        const pending = pendingChoiceRef.current;
        if (pending?.songId === songId && pending.from === visualizerMode && pending.modes === modes) return;
        pendingChoiceRef.current = { songId, from: visualizerMode, modes };

        const nextMode = pickRandomVisualizerMode(modes, visualizerMode);
        if (nextMode !== visualizerMode) {
            setVisualizerMode(nextMode, { notify: false, preserveRandom: true });
        }
    }, [currentSong, enabled, modes, setVisualizerMode, visualizerMode]);
}
