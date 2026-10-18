import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearAudioStart,
    describeAudioStart,
    readAudioStart,
    recordAudioStart,
    type AudioStartReport,
} from '@/services/playback/audioStartupProbe';

// test/unit/playback/audioStartupProbe.test.ts
// HUD 的 `audio` 行：正常播放时一行字就够，出问题时得带上判断用的数字（多少毫秒、
// AudioContext 什么状态、元素停在哪个 readyState）。蓝牙那次取证全靠这一行。

const report = (overrides: Partial<AudioStartReport> = {}): AudioStartReport => ({
    step: 'play',
    outcome: 'ok',
    elapsedMs: 120,
    contextState: 'running',
    readyState: 4,
    networkState: 1,
    errorName: null,
    ...overrides,
});

describe('audio startup probe', () => {
    beforeEach(() => clearAudioStart());

    it('starts empty, so the HUD can say idle before anything plays', () => {
        expect(readAudioStart()).toBeNull();
        expect(describeAudioStart(null)).toBe('idle');
    });

    it('keeps the last step it was told about', () => {
        recordAudioStart('resume', 'ok', performance.now() - 5, null, null);
        const last = readAudioStart()!;
        expect(last.step).toBe('resume');
        expect(last.outcome).toBe('ok');
        // 没有上下文 / 元素时如实记 absent 与 -1，不猜。
        expect(last.contextState).toBe('absent');
        expect(last.readyState).toBe(-1);
        expect(last.networkState).toBe(-1);
        expect(last.errorName).toBeNull();
    });

    it('reads a healthy start as step, outcome and context state only', () => {
        expect(describeAudioStart(report())).toBe('play:ok · running');
        expect(describeAudioStart(report({ step: 'resume' }))).toBe('resume:ok · running');
    });

    it('adds the numbers that tell a stall apart from a failure', () => {
        expect(describeAudioStart(report({ outcome: 'timeout', elapsedMs: 4000, readyState: 0, networkState: 2 })))
            .toBe('play:timeout · running · 4000 ms · rs 0/2');
    });

    it('names a rejected start when the element carries an error', () => {
        expect(describeAudioStart(report({ outcome: 'rejected', elapsedMs: 30, errorName: 'MEDIA_ERR_SRC_NOT_SUPPORTED' })))
            .toBe('play:rejected · running · 30 ms · rs 4/1 · MEDIA_ERR_SRC_NOT_SUPPORTED');
    });
});
