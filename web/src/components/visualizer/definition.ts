import React from 'react';
import { type MotionValue } from 'framer-motion';
import {
    type AudioBands,
    type CappellaAvatarImage,
    type CappellaEmojiImage,
    type CappellaTuning,
    type CadenzaTuning,
    type ClassicTuning,
    type CladdaghTuning,
    type DioramaTuning,
    type FumeTuning,
    type Line,
    type LumiereTuning,
    type MonetPortraitImage,
    type MonetTuning,
    type PartitaTuning,
    type PendoloTuning,
    type SonnetTuning,
    type SubtitleContentMode,
    type TemperaTuning,
    type Theme,
    type TiltTuning,
    type VisualizerMode,
} from '../../types';
import type { VisualizerTuningBundle } from './tuningRegistry';
import type { VisualizerBackgroundConfig } from './backgrounds/definition';
import type { BeatEffectDef } from '../../services/beatFx/beatEffects';
import type { HanabiTuning } from './hanabi/types';

// src/components/visualizer/definition.ts
// Shared contracts for discoverable visualizer modes.
export type VisualizerTuningKind = 'none' | 'classic' | 'cadenza' | 'partita' | 'fume' | 'claddagh' | 'cappella' | 'tilt' | 'monet' | 'diorama' | 'pendolo' | 'sonnet' | 'tempera' | 'lumiere' | 'hanabi';

/**
 * 播放面板上的快捷开关拿到的上下文（上游 v0.7.22 的契约，花火用它在面板上放两个开关）。
 * `tuning` 的具体类型由各样式自己在 entry 里指定。
 */
export interface VisualizerQuickControlsProps<T = unknown> {
    tuning: T;
    onTuningChange: (patch: Partial<T>) => void;
    t: (key: string) => string;
}

export interface VisualizerSharedProps {
    currentTime: MotionValue<number>;
    currentLineIndex: number;
    lines: Line[];
    theme: Theme;
    subtitleTheme?: Theme;
    isDaylight?: boolean;
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    showText?: boolean;
    songTitle?: string | null;
    songArtist?: string | null;
    songAlbum?: string | null;
    coverUrl?: string | null;
    /**
     * Tempera canvas images shipped inline by the OBS overlay. That page is a separate browsing
     * context with no access to the app's IndexedDB, so when this is present the visualizer uses
     * it instead of reading the pool from storage.
     */
    temperaLayerImageAssets?: { id: string; name: string; url: string }[];
    seed?: string | number;
    staticMode?: boolean;
    backgroundStaticMode?: boolean;
    visualizerOpacity?: number;
    background?: VisualizerBackgroundConfig;
    lyricsFontScale?: number;
    subtitleFontScale?: number;
    subtitleOverlayOpacity?: number;
    subtitleOverlayBackground?: boolean;
    subtitleUpcomingLyricsBlur?: boolean;
    showHarmonySubtitle?: boolean;
    harmonySubtitleBackground?: boolean;
    isPlayerChromeHidden?: boolean;
    hideTranslationSubtitle?: boolean;
    showSubtitleTranslation?: boolean;
    subtitleContentMode?: SubtitleContentMode;
    paused?: boolean;
    onBack?: () => void;
    isPanelOpen?: boolean;
    alwaysShowBackButton?: boolean;
    onPlayerPanelGuideHotspotChange?: (isActive: boolean) => void;
    onLyricLineSeek?: (lyricTimeSec: number) => void;
    isPreviewMode?: boolean;
    visualizerTunings?: VisualizerTuningBundle;
    classicTuning?: ClassicTuning;
    cadenzaTuning?: CadenzaTuning;
    partitaTuning?: PartitaTuning;
    fumeTuning?: FumeTuning;
    claddaghTuning?: CladdaghTuning;
    onCladdaghTuningChange?: (patch: Partial<CladdaghTuning>) => void;
    cappellaTuning?: CappellaTuning;
    cappellaCustomEmojiImages?: CappellaEmojiImage[];
    cappellaCustomAvatarImages?: CappellaAvatarImage[];
    tiltTuning?: TiltTuning;
    dioramaTuning?: DioramaTuning;
    monetTuning?: MonetTuning;
    monetPortraitImage?: MonetPortraitImage | null;
    onMonetTuningChange?: (patch: Partial<MonetTuning>) => void;
    pendoloTuning?: PendoloTuning;
    onPendoloTuningChange?: (patch: Partial<PendoloTuning>) => void;
    sonnetTuning?: SonnetTuning;
    onSonnetTuningChange?: (patch: Partial<SonnetTuning>) => void;
    temperaTuning?: TemperaTuning;
    onTemperaTuningChange?: (patch: Partial<TemperaTuning>) => void;
    lumiereTuning?: LumiereTuning;
    onLumiereTuningChange?: (patch: Partial<LumiereTuning>) => void;
    hanabiTuning?: HanabiTuning;
    onHanabiTuningChange?: (patch: Partial<HanabiTuning>) => void;
}

export interface VisualizerSettingsPanelProps {
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
    controlCardBg: string;
    rangeInputClass: string;
    classicTuning?: ClassicTuning;
    onClassicTuningChange?: (patch: Partial<ClassicTuning>) => void;
    partitaTuning?: PartitaTuning;
    onPartitaTuningChange?: (patch: Partial<PartitaTuning>) => void;
    fumeTuning?: FumeTuning;
    onFumeTuningChange?: (patch: Partial<FumeTuning>) => void;
    claddaghTuning?: CladdaghTuning;
    onCladdaghTuningChange?: (patch: Partial<CladdaghTuning>) => void;
    cappellaTuning?: CappellaTuning;
    cappellaCustomEmojiImages?: CappellaEmojiImage[];
    onCappellaTuningChange?: (patch: Partial<CappellaTuning>) => void;
    cappellaCustomEmojiCount?: number;
    hasCappellaCustomEmojiPack?: boolean;
    isCappellaCustomEmojiPackLoading?: boolean;
    onImportCappellaCustomEmojiPack?: (files: File[]) => Promise<{ ok: boolean; error?: string; }>;
    onClearCappellaCustomEmojiPack?: () => Promise<void> | void;
    cappellaCustomAvatarImages?: CappellaAvatarImage[];
    onImportCappellaCustomAvatar?: (files: File[]) => Promise<{ ok: boolean; error?: string; }>;
    onClearCappellaCustomAvatar?: () => Promise<void> | void;
    hasCappellaCustomAvatar?: boolean;
    isCappellaCustomAvatarLoading?: boolean;
    tiltTuning?: TiltTuning;
    onTiltTuningChange?: (patch: Partial<TiltTuning>) => void;
    dioramaTuning?: DioramaTuning;
    onDioramaTuningChange?: (patch: Partial<DioramaTuning>) => void;
    monetTuning?: MonetTuning;
    onMonetTuningChange?: (patch: Partial<MonetTuning>) => void;
    monetPortraitImage?: MonetPortraitImage | null;
    onUploadMonetPortraitImage?: (files: File[]) => Promise<{ ok: boolean; error?: string; }>;
    onClearMonetPortraitImage?: () => Promise<void> | void;
    isLoadingMonetPortraitImage?: boolean;
    pendoloTuning?: PendoloTuning;
    onPendoloTuningChange?: (patch: Partial<PendoloTuning>) => void;
    sonnetTuning?: SonnetTuning;
    onSonnetTuningChange?: (patch: Partial<SonnetTuning>) => void;
    temperaTuning?: TemperaTuning;
    onTemperaTuningChange?: (patch: Partial<TemperaTuning>) => void;
    lumiereTuning?: LumiereTuning;
    onLumiereTuningChange?: (patch: Partial<LumiereTuning>) => void;
    hanabiTuning?: HanabiTuning;
    onHanabiTuningChange?: (patch: Partial<HanabiTuning>) => void;
    /** Mark slider drag start so onChange only updates draft. */
    onSliderPointerDown?: () => void;
    /** Commit draft values to persistent store on slider release. */
    onSliderCommit?: () => void;
}

export interface VisualizerSettingsResetProps {
    resetClassicTuning?: () => void;
    resetPartitaTuning?: () => void;
    resetFumeTuning?: () => void;
    resetCladdaghTuning?: () => void;
    resetCappellaTuning?: () => void;
    resetTiltTuning?: () => void;
    resetDioramaTuning?: () => void;
    resetMonetTuning?: () => void;
    resetPendoloTuning?: () => void;
    resetSonnetTuning?: () => void;
    resetTemperaTuning?: () => void;
    resetLumiereTuning?: () => void;
    setDraftFumeTuning?: (tuning: FumeTuning) => void;
    setDraftCladdaghTuning?: (tuning: CladdaghTuning) => void;
    setDraftPendoloTuning?: (tuning: PendoloTuning) => void;
    setDraftSonnetTuning?: (tuning: SonnetTuning) => void;
    setDraftTemperaTuning?: (tuning: TemperaTuning) => void;
    setDraftLumiereTuning?: (tuning: LumiereTuning) => void;
}

export interface VisualizerRegistryEntry {
    mode: VisualizerMode;
    order: number;
    labelKey: string;
    labelFallback: string;
    previewSeed: string;
    previewStartOffset: number;
    tuningKind: VisualizerTuningKind;
    /*
     * 下面几个字段是随花火从上游 v0.7.22 带进来的可选契约：
     * 图标、命令面板条目、智能动感效果声明、播放面板快捷开关、独立的字号提示。
     * 都是可选的，现有 13 个样式不填也照旧工作；读取方按需取。
     */
    glyph?: React.ReactNode;
    command?: { title: string; description?: string; keywords?: string[]; };
    beatEffects?: readonly BeatEffectDef[];
    renderQuickControls?: (props: VisualizerQuickControlsProps<never>) => React.ReactNode;
    ownFontSizeNoticeKey?: string;
    /*
     * 各模式的 entry.tsx 把真正的 renderer 包成 React.lazy —— registry 用 eager glob 发现
     * entry，如果 entry 静态 import renderer，任何碰 visualizer 设置的模块都会连带拉进 13 个
     * renderer（183 个模块，含 three.js，而 three 只有 diorama 用）。契约不变：这里仍然是
     * props => ReactElement，lazy 组件照样满足。代价是调用方必须提供 Suspense 边界。
     */
    render: (props: VisualizerSharedProps) => React.ReactElement;
    renderSettingsPanel?: (props: VisualizerSettingsPanelProps) => React.ReactNode;
    resetSettings?: (props: VisualizerSettingsResetProps) => void;
    /*
     * True when this mode's layout atoms come from whole-line word segmentation
     * (utils/lyrics/wordSegmentation), so the user's saved split for a song changes what it draws.
     * Declared here rather than as a list in the panel: the panel and the command both ask the
     * registry, so adding a mode does not mean remembering to edit a hardcoded set.
     * Grapheme-level modes leave it unset — a word split would not affect them.
     */
    usesWordSegmentation?: boolean;
    /*
     * Folium tunables: the multiplier keys this mode reads through
     * useFoliumTunings(mode), with the range a mod may set and the identity
     * value (the unmodified look). Declaring a key makes its name public API —
     * mods address it by name, so renaming it is a breaking Folium change.
     * Modes without this field cannot be targeted by `registries.tunings`.
     */
    foliumTunables?: Readonly<Record<string, FoliumTunable>>;
}

export interface FoliumTunable {
    min: number;
    max: number;
    identity: number;
}

export interface VisualizerEntryModule {
    default: VisualizerRegistryEntry;
}

export const defineVisualizer = (entry: VisualizerRegistryEntry) => entry;
