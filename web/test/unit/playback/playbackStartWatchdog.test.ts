import { describe, expect, it } from 'vitest';
import { PLAYBACK_POSITION_TOLERANCE_SEC, describePlaybackStart, judgePlaybackStart } from '../../../src/services/playback/playbackStartWatchdog';

// test/unit/playback/playbackStartWatchdog.test.ts
// 「进了 PLAYING 却没声音」那种沉默的判定守卫：同一个「没声音」下面藏着两种完全不同的病，
// 元素没动和 context 不在 running 要分开报，正常播放必须一个问题都不报。

describe('judgePlaybackStart', () => {
    it('元素走了、context 在 running：没问题', () => {
        expect(judgePlaybackStart({ contextState: 'running', positionBeforeSec: 3, positionNowSec: 4.4 }))
            .toEqual({ kind: 'ok' });
    });

    it('没建 Web Audio（absent）时声音走元素直出，也不算问题', () => {
        expect(judgePlaybackStart({ contextState: 'absent', positionBeforeSec: 0, positionNowSec: 1.5 }))
            .toEqual({ kind: 'ok' });
    });

    it('元素在走、context 停在 interrupted：声音被 Web Audio 那一层卡住', () => {
        expect(judgePlaybackStart({ contextState: 'interrupted', positionBeforeSec: 3, positionNowSec: 4.44 }))
            .toEqual({ kind: 'context-idle', contextState: 'interrupted', positionSec: 4.4 });
    });

    it('元素自己没动：比 context 状态更靠前的问题', () => {
        expect(judgePlaybackStart({ contextState: 'running', positionBeforeSec: 3, positionNowSec: 3 }))
            .toEqual({
                kind: 'element-stalled',
                contextState: 'running',
                positionSec: 3,
                readyState: -1,
                networkState: -1,
                paused: false,
                advanceSec: 0,
            });
    });

    it('元素没动时把数据档位、网络档位、是否被暂停一起带出来', () => {
        expect(judgePlaybackStart({
            contextState: 'running',
            positionBeforeSec: 0,
            positionNowSec: 0.02,
            readyState: 2,
            networkState: 2,
            paused: false,
        })).toMatchObject({ kind: 'element-stalled', readyState: 2, networkState: 2, paused: false, advanceSec: 0.02 });
    });

    it('走不到容差就算没动（差一点点不算起步）', () => {
        expect(judgePlaybackStart({
            contextState: 'running',
            positionBeforeSec: 3,
            positionNowSec: 3 + PLAYBACK_POSITION_TOLERANCE_SEC / 2,
        }).kind).toBe('element-stalled');
    });

    it('没有元素（-1）也算没动', () => {
        expect(judgePlaybackStart({ contextState: 'running', positionBeforeSec: -1, positionNowSec: -1 }).kind).toBe('element-stalled');
    });
});

describe('describePlaybackStart', () => {
    it('正常时不弹任何东西', () => {
        expect(describePlaybackStart({ kind: 'ok' })).toBe('');
    });

    it('context 那一档带上状态与元素位置', () => {
        expect(describePlaybackStart({ kind: 'context-idle', contextState: 'suspended', positionSec: 4.44 }))
            .toBe('ctx:suspended · el 4.4s');
    });

    it('元素那一档写明是元素没动，并带上判因要用的数', () => {
        expect(describePlaybackStart({
            kind: 'element-stalled',
            contextState: 'running',
            positionSec: 0,
            readyState: 2,
            networkState: 2,
            paused: false,
            advanceSec: 0.02,
        })).toBe('el:stalled · rs 2/2 · p 0 · +0.02s');
    });

    it('被暂停时 p 写 1', () => {
        expect(describePlaybackStart({
            kind: 'element-stalled',
            contextState: 'running',
            positionSec: 0,
            readyState: 4,
            networkState: 1,
            paused: true,
            advanceSec: 0,
        })).toBe('el:stalled · rs 4/1 · p 1 · +0.00s');
    });
});
