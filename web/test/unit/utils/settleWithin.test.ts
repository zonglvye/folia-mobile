import { describe, expect, it, vi } from 'vitest';
import { settleWithin } from '@/utils/settleWithin';

// test/unit/utils/settleWithin.test.ts
// 有期限地等一个 promise：三种结局要分得开，超时之后原 promise 再拒绝也不能变成未处理的 rejection
// （那会被事故记录器记成一条假故障，把蓝牙取证的现场搅乱）。

describe('settleWithin', () => {
    it('passes a value through', async () => {
        await expect(settleWithin(Promise.resolve(7), 50)).resolves.toEqual({ status: 'ok', value: 7 });
    });

    it('reports a rejection with the original error', async () => {
        const boom = new Error('boom');
        await expect(settleWithin(Promise.reject(boom), 50)).resolves.toEqual({ status: 'rejected', error: boom });
    });

    it('gives up on a promise that never settles', async () => {
        vi.useFakeTimers();
        try {
            const pending = new Promise<never>(() => {});
            const outcome = settleWithin(pending, 1200);
            await vi.advanceTimersByTimeAsync(1199);
            // 还没到期限：race 不该有结果。attach 一个哨兵判断它确实还悬着。
            let settled = false;
            void outcome.then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(outcome).resolves.toEqual({ status: 'timeout' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a late rejection from becoming an unhandled rejection', async () => {
        vi.useFakeTimers();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            let rejectLate: (error: Error) => void = () => {};
            const pending = new Promise<never>((_, reject) => { rejectLate = reject; });
            const outcome = settleWithin(pending, 1200);
            await vi.advanceTimersByTimeAsync(1200);
            await expect(outcome).resolves.toEqual({ status: 'timeout' });
            // 超时之后原 promise 才拒绝：这里必须是被接管的，不能抛到外面。
            rejectLate(new Error('late'));
            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            vi.useRealTimers();
        }
    });

    it('does not cancel the promise it gave up on', async () => {
        vi.useFakeTimers();
        try {
            let resolveLate: (value: number) => void = () => {};
            const pending = new Promise<number>(resolve => { resolveLate = resolve; });
            const outcome = settleWithin(pending, 10);
            await vi.advanceTimersByTimeAsync(10);
            await expect(outcome).resolves.toEqual({ status: 'timeout' });
            // 调用方拿着原 promise 继续等：它自己照常决议。
            resolveLate(42);
            await expect(pending).resolves.toBe(42);
        } finally {
            vi.useRealTimers();
        }
    });
});
