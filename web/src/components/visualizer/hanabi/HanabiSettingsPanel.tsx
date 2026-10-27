// Copyright (c) 2026 chthollyphile
import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { VisualizerSettingsPanelProps } from '../definition';
import VisualizerPresetGroup, { type VisualizerPresetOption } from '../VisualizerPresetGroup';
import { TemperaRangeControl as RangeControl, TemperaSettingsSection as SettingsSection } from '../tempera/TemperaSettingsControls';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import type { HanabiRenderQuality, HanabiTuning } from './types';

// src/components/visualizer/hanabi/HanabiSettingsPanel.tsx
//
// 花火的参数面板：画面、歌词、烟花、夜空与镜头、辉光、画质六组。
//
// 与其它样式不同的两点，都是为了少改本仓库既有的装配层：
//   1. 上游这份面板用的是 0.7.21 的设置套件（Group/Row/Segmented/PictureChecks），我们改用
//      tempera 那套现成的 RangeControl / SettingsSection / VisualizerPresetGroup。
//   2. 参数与 setter 直接从 store 取，不从 props 里拿：props 里的 hanabiTuning 需要在
//      SettingsModal / VisPlayground 两处装配点各加一段，而 store 本来就是唯一真相。

type NumberKey = { [K in keyof HanabiTuning]: HanabiTuning[K] extends number ? K : never }[keyof HanabiTuning];
type BooleanKey = { [K in keyof HanabiTuning]: HanabiTuning[K] extends boolean ? K : never }[keyof HanabiTuning];

interface SliderSpec { kind: 'slider'; key: NumberKey; labelKey: string; min: number; max: number; step?: number; }
interface ToggleSpec { kind: 'toggle'; key: BooleanKey; labelKey: string; }
type ControlSpec = SliderSpec | ToggleSpec;

const slider = (key: NumberKey, labelKey: string, min: number, max: number, step = 0.05): SliderSpec => (
    { kind: 'slider', key, labelKey, min, max, step }
);
const toggle = (key: BooleanKey, labelKey: string): ToggleSpec => ({ kind: 'toggle', key, labelKey });

const STAGE_CONTROLS: ControlSpec[] = [
    toggle('textOnly', 'options.hanabiTextOnly'),
    toggle('overlayFrame', 'options.hanabiOverlayFrame'),
];

const TEXT_CONTROLS: ControlSpec[] = [
    slider('textMotion', 'options.hanabiTextMotion', 0, 2),
    slider('blockOpacity', 'options.hanabiBlockOpacity', 0, 1, 0.01),
    slider('collage', 'options.hanabiCollage', 0, 2),
];

const FIREWORK_CONTROLS: ControlSpec[] = [
    slider('sparkAmount', 'options.hanabiSparkAmount', 0, 2),
    slider('glow', 'options.hanabiGlow', 0, 2),
    slider('ornamentAmount', 'options.hanabiOrnamentAmount', 0, 2),
    toggle('launches', 'options.hanabiLaunches'),
];

const CAMERA_CONTROLS: ControlSpec[] = [
    slider('sky', 'options.hanabiSky', 0, 1, 0.01),
    slider('riseSpeed', 'options.hanabiRiseSpeed', 0, 2),
    slider('spin', 'options.hanabiSpin', 0, 2),
    slider('ambient', 'options.hanabiAmbient', 0, 2),
];

const BLOOM_CONTROLS: ControlSpec[] = [
    slider('bloom', 'options.hanabiBloom', 0, 2),
    slider('chorusBloom', 'options.hanabiChorusBloom', 0, 2),
];

const formatPlain = (value: number) => value.toFixed(2);

const HanabiSettingsPanel: React.FC<VisualizerSettingsPanelProps> = ({
    t,
    isDaylight,
    theme,
    rangeInputClass,
    controlCardBg,
}) => {
    const { tuning, onTuningChange, onReset } = useVisualizerSettingsStore(useShallow(state => ({
        tuning: state.hanabiTuning,
        onTuningChange: state.handleSetHanabiTuning,
        onReset: state.handleResetHanabiTuning,
    })));

    const booleanOptions: VisualizerPresetOption<boolean>[] = useMemo(() => ([
        { value: true, label: t('options.hanabiToggleOn') },
        { value: false, label: t('options.hanabiToggleOff') },
    ]), [t]);

    const colorModeOptions: VisualizerPresetOption<HanabiTuning['colorMode']>[] = useMemo(() => ([
        { value: 'theme', label: t('options.hanabiColorModeTheme') },
        { value: 'vivid', label: t('options.hanabiColorModeVivid') },
        { value: 'mixed', label: t('options.hanabiColorModeMixed') },
    ]), [t]);

    const qualityOptions: VisualizerPresetOption<HanabiRenderQuality>[] = useMemo(() => ([
        { value: 'full', label: t('options.hanabiQualityFull') },
        { value: 'balanced', label: t('options.hanabiQualityBalanced') },
        { value: 'low', label: t('options.hanabiQualityLow') },
    ]), [t]);

    const renderControl = (spec: ControlSpec) => (spec.kind === 'slider' ? (
        <RangeControl
            key={spec.key}
            label={t(spec.labelKey)}
            value={tuning[spec.key]}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 0.05}
            formatValue={formatPlain}
            rangeInputClass={rangeInputClass}
            onChange={value => onTuningChange({ [spec.key]: value })}
        />
    ) : (
        <VisualizerPresetGroup
            key={spec.key}
            label={t(spec.labelKey)}
            value={tuning[spec.key]}
            options={booleanOptions}
            onChange={value => onTuningChange({ [spec.key]: value })}
            isDaylight={isDaylight}
            theme={theme}
        />
    ));

    const hint = (key: string) => (
        <p className="text-xs leading-relaxed opacity-55" style={{ color: 'var(--text-secondary)' }}>{t(key)}</p>
    );

    return (
        <div className="rounded-[24px] border border-white/10 p-4 space-y-4" style={{ backgroundColor: controlCardBg }}>
            <div className="space-y-1">
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('options.hanabiSettings')}
                </div>
                <div className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.hanabiSettingsDesc')}
                </div>
            </div>

            <SettingsSection title={t('options.hanabiStageSection')}>
                <VisualizerPresetGroup
                    label={t('options.hanabiColorMode')}
                    value={tuning.colorMode}
                    options={colorModeOptions}
                    onChange={value => onTuningChange({ colorMode: value })}
                    isDaylight={isDaylight}
                    theme={theme}
                />
                {STAGE_CONTROLS.map(renderControl)}
            </SettingsSection>

            <SettingsSection title={t('options.hanabiTextSection')}>
                {TEXT_CONTROLS.map(renderControl)}
                {hint('options.hanabiBlockOpacityHint')}
            </SettingsSection>

            <SettingsSection title={t('options.hanabiFireworkSection')}>
                {FIREWORK_CONTROLS.map(renderControl)}
            </SettingsSection>

            <SettingsSection title={t('options.hanabiCameraSection')}>
                {CAMERA_CONTROLS.map(renderControl)}
                {hint('options.hanabiSpinHint')}
            </SettingsSection>

            <SettingsSection title={t('options.hanabiBloomSection')}>
                {BLOOM_CONTROLS.map(renderControl)}
            </SettingsSection>

            <SettingsSection title={t('options.hanabiQualitySection')}>
                <VisualizerPresetGroup
                    label={t('options.hanabiRenderQuality')}
                    value={tuning.renderQuality}
                    options={qualityOptions}
                    onChange={value => onTuningChange({ renderQuality: value })}
                    isDaylight={isDaylight}
                    theme={theme}
                />
                {hint('options.hanabiQualityHint')}
            </SettingsSection>

            <button
                type="button"
                onClick={onReset}
                className="w-full rounded-xl border border-white/10 py-2 text-xs opacity-70 hover:opacity-100 transition-opacity"
                style={{ color: 'var(--text-primary)' }}
            >
                {t('options.hanabiResetAll')}
            </button>
        </div>
    );
};

export default HanabiSettingsPanel;
