// src/components/panelTab/controls/RandomLyricStylePool.tsx
//
// 控制页里「每首随机」的开关和它的抽签池。
//
// 上游 v0.7.22 把它做成一整页（RandomPoolPicker + PictureChecks，基于设置套件），我们这边控制页
// 只有 320px 宽，所以收成一望即知的形态：一行开关，打开之后下面是一格一格的样式名单，
// 勾上的就是会被抽到的。
//
// 状态直接读 useVisualizerSettingsStore：控制页本来就在面板里，多传两三个 prop 只会让
// ControlsTab 的模型更胖。
import React from 'react';
import { Shuffle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Theme, VisualizerMode } from '../../../types';
import { BUILTIN_VISUALIZER_MODES } from '../../../types/visualizerModes';
import { getVisualizerModeLabel, VISUALIZER_REGISTRY } from '../../visualizer/registry';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';

type RandomLyricStylePoolProps = {
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
};

const builtinModes = new Set<string>(BUILTIN_VISUALIZER_MODES);
// 只列内置样式：模组样式可以随时被禁用，进池子只会抽到一个不存在的画面。
const POOL_CHOICES = VISUALIZER_REGISTRY
    .filter(entry => builtinModes.has(entry.mode))
    .map(entry => entry.mode);

const RandomLyricStylePool: React.FC<RandomLyricStylePoolProps> = ({ t, isDaylight, theme }) => {
    const { enabled, modes, currentMode, onToggle, onSetModes } = useVisualizerSettingsStore(useShallow(state => ({
        enabled: state.randomVisualizerModePerSong,
        modes: state.randomVisualizerModes,
        currentMode: state.visualizerMode,
        onToggle: state.handleToggleRandomVisualizerModePerSong,
        onSetModes: state.handleSetRandomVisualizerModes,
    })));

    const selected = new Set<string>(modes);
    const allSelected = POOL_CHOICES.every(mode => selected.has(mode));
    const accent = theme?.accentColor || (isDaylight ? '#18181b' : '#f4f4f5');
    const idleText = isDaylight ? 'text-zinc-500' : 'text-white/50';

    const toggleMode = (mode: VisualizerMode) => {
        const next = selected.has(mode)
            // 最后一格不让取消：池子空了就没有随机可言（store 那边也会退回全选）。
            ? (modes.length <= 1 ? modes : modes.filter(item => item !== mode))
            : [...modes.filter(item => builtinModes.has(item)), mode];
        onSetModes(next);
    };

    return (
        <div className="pt-1">
            <div className="flex items-center justify-between px-1 py-1">
                <span className={`flex items-center gap-1.5 text-[11px] ${isDaylight ? 'text-zinc-600' : 'text-white/60'}`}>
                    <Shuffle size={12} />
                    {t('options.randomVisualizerPerSong')}
                </span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={t('options.randomVisualizerPerSong')}
                    onClick={() => onToggle(!enabled, { notify: false })}
                    className="relative w-9 h-5 rounded-full transition-all shrink-0"
                    style={{ backgroundColor: enabled ? accent : (isDaylight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.16)') }}
                >
                    <span
                        className={`absolute top-0.5 w-4 h-4 rounded-full transition-transform shadow-sm ${enabled ? 'translate-x-[18px]' : 'translate-x-0.5'} ${isDaylight ? 'bg-white' : 'bg-zinc-100'}`}
                    />
                </button>
            </div>

            {enabled && (
                <div className="px-1 pb-1">
                    <div className="flex items-center justify-between mb-1">
                        <span className={`text-[10px] ${idleText}`}>{t('options.randomVisualizerPoolHint')}</span>
                        <button
                            type="button"
                            disabled={allSelected}
                            onClick={() => onSetModes(BUILTIN_VISUALIZER_MODES)}
                            className={`text-[10px] ${allSelected ? 'opacity-30' : 'opacity-70 hover:opacity-100'}`}
                        >
                            {t('options.randomVisualizerSelectAll')}
                        </button>
                    </div>
                    <div role="group" aria-label={t('options.randomVisualizerModes')} className="flex flex-wrap gap-1">
                        {POOL_CHOICES.map((mode) => {
                            const checked = selected.has(mode);
                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={checked}
                                    onClick={() => toggleMode(mode)}
                                    className={`px-1.5 py-0.5 rounded-md text-[11px] leading-4 transition-colors ${checked ? '' : `${idleText} ${isDaylight ? 'bg-black/5' : 'bg-white/5'}`}`}
                                    style={checked ? { backgroundColor: `${accent}26`, color: accent } : undefined}
                                >
                                    {getVisualizerModeLabel(mode, t)}
                                </button>
                            );
                        })}
                    </div>
                    {selected.has(currentMode) && (
                        <p className={`mt-1 text-[10px] ${idleText}`}>{t('options.randomVisualizerCurrentInPool')}</p>
                    )}
                </div>
            )}
        </div>
    );
};

export default RandomLyricStylePool;
