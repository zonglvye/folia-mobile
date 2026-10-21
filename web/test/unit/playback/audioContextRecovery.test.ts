// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bounceAudioContext, isAudioContextZombie, keepAudioContextAwake, needsAudioResume } from '../../../src/services/playback/audioContextRecovery';

// test/unit/playback/audioContextRecovery.test.ts
// 蓝牙耳机反复失效的那个问题的守卫：安卓上被系统收走的 context 停在 'interrupted' 而不是 'suspended'，
// 所以判定不能只认 'suspended'；唤醒要发生在用户手势上，且 running 时不能有任何多余动作。
// 另外钉住「假 running」的两件事：怎么从元素身上认出来（readyState ≥ 2 且没暂停），以及救它的那一跳。

const fakeContext = (state: string) => {
    const resume = vi.fn(async () => {
        context.state = 'running';
    });
    const context = { state, resume } as unknown as AudioContext & { state: string };
    return { context, resume };
};

const gesture = () => window.dispatchEvent(new Event('pointerdown', { bubbles: true }));

describe('needsAudioResume', () => {
    it('只认 running 是「在走」', () => {
        expect(needsAudioResume('running')).toBe(false);
    });

    it('安卓被系统收走时的 interrupted 也要重新拉', () => {
        expect(needsAudioResume('interrupted')).toBe(true);
    });

    it('suspended 与 closed 都要重新拉', () => {
        expect(needsAudioResume('suspended')).toBe(true);
        expect(needsAudioResume('closed')).toBe(true);
    });
});

describe('keepAudioContextAwake', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('手势会把停在 interrupted 的 context 叫醒', () => {
        const { context, resume } = fakeContext('interrupted');
        keepAudioContextAwake(context);
        gesture();
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('running 时手势什么也不做', () => {
        const { context, resume } = fakeContext('running');
        keepAudioContextAwake(context);
        gesture();
        gesture();
        expect(resume).not.toHaveBeenCalled();
    });

    it('同一个 context 装两次也只发一次 resume', () => {
        const { context, resume } = fakeContext('suspended');
        keepAudioContextAwake(context);
        keepAudioContextAwake(context);
        gesture();
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('状态掉出 running 之后自己补一次重试，不必等下一次手势', () => {
        vi.useFakeTimers();
        const { context, resume } = fakeContext('running');
        keepAudioContextAwake(context);
        context.state = 'interrupted';
        context.onstatechange!(new Event('statechange'));
        expect(resume).not.toHaveBeenCalled();
        vi.advanceTimersByTime(500);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('resume 失败不外抛（下次手势还会再试）', () => {
        const context = { state: 'interrupted', resume: vi.fn(async () => { throw new Error('no route'); }) } as unknown as AudioContext;
        keepAudioContextAwake(context);
        expect(() => gesture()).not.toThrow();
    });
});

describe('isAudioContextZombie', () => {
    const element = (readyState: number, paused: boolean) => ({ readyState, paused }) as unknown as HTMLAudioElement;

    it('数据齐了、没人暂停 —— 只要时钟不在走就是这个状态', () => {
        expect(isAudioContextZombie(element(4, false))).toBe(true);
        expect(isAudioContextZombie(element(2, false))).toBe(true);
    });

    it('还在等数据的（readyState < 2）不算：那是没数据，不是假 running', () => {
        expect(isAudioContextZombie(element(1, false))).toBe(false);
        expect(isAudioContextZombie(element(0, false))).toBe(false);
    });

    it('被暂停的、没有元素的都不算', () => {
        expect(isAudioContextZombie(element(4, true))).toBe(false);
        expect(isAudioContextZombie(null)).toBe(false);
    });
});

describe('bounceAudioContext', () => {
    it('先 suspend 再 resume，顺序不能反（这一跳就是关掉再重开输出流）', async () => {
        const calls: string[] = [];
        const context = {
            suspend: vi.fn(async () => { calls.push('suspend'); }),
            resume: vi.fn(async () => { calls.push('resume'); }),
        } as unknown as AudioContext;
        await expect(bounceAudioContext(context)).resolves.toBe(true);
        expect(calls).toEqual(['suspend', 'resume']);
    });

    it('suspend 被拒也照样 resume', async () => {
        const resume = vi.fn(async () => undefined);
        const context = {
            suspend: vi.fn(async () => { throw new Error('cannot suspend'); }),
            resume,
        } as unknown as AudioContext;
        await expect(bounceAudioContext(context)).resolves.toBe(true);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('resume 也失败时返回 false（由调用方收尾），且不外抛', async () => {
        const context = {
            suspend: vi.fn(async () => undefined),
            resume: vi.fn(async () => { throw new Error('no output'); }),
        } as unknown as AudioContext;
        await expect(bounceAudioContext(context)).resolves.toBe(false);
    });

    it('没有 context 时直接 false', async () => {
        await expect(bounceAudioContext(null)).resolves.toBe(false);
    });
});
