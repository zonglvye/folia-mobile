import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/neteaseBackend.test.ts
// 网易后端的错误边界：上游包加载前的准备失败（#690：临时目录不可用）不能带崩主进程，要变成 load 步骤的失败与 error 状态。

const { createNeteaseBackend } = require('../../../electron/neteaseBackend.cjs') as {
    createNeteaseBackend: (options: Record<string, unknown>) => {
        start: () => Promise<any>;
        getStatus: () => any;
        getPort: () => number | null;
        getDiagnostics: () => any;
    };
};

const TEMP_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;
const savedTemp = Object.fromEntries(TEMP_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
    for (const key of TEMP_KEYS) {
        if (savedTemp[key] === undefined) delete process.env[key];
        else process.env[key] = savedTemp[key];
    }
});

/** 让 os.tmpdir() 指向一个不存在的目录，复现 TEMP=%USERPROFILE%\... 没展开时的情形。 */
const pointTempAtMissingDirectory = () => {
    const missing = path.join(os.tmpdir(), `folia-missing-${process.pid}-${Date.now()}`, '%USERPROFILE%', 'Temp');
    for (const key of TEMP_KEYS) process.env[key] = missing;
    return missing;
};

describe('NetEase backend load boundary', () => {
    it('turns a failed upstream preparation into an error status instead of throwing', async () => {
        const missing = pointTempAtMissingDirectory();
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const broadcast = vi.fn();

        const backend = createNeteaseBackend({ broadcast, logger, now: () => 1000 });
        expect(logger.error).toHaveBeenCalledWith('[Netease API] failed to load upstream package', expect.any(Error));

        const status = await backend.start();
        expect(status).toMatchObject({ status: 'error', port: null });
        expect(status.error).toMatch(/^load: ENOENT/);
        expect(status.error).toContain(missing);
        expect(backend.getPort()).toBeNull();
        expect(broadcast).toHaveBeenLastCalledWith('netease-api-status-changed', status);

        const diagnostics = backend.getDiagnostics();
        expect(diagnostics.login).toBeNull();
        expect(diagnostics.identity).toBeNull();
        expect(diagnostics.startup).toEqual([expect.objectContaining({
            outcome: 'failed',
            steps: [expect.objectContaining({ id: 'load', outcome: 'failed', error: expect.stringContaining('ENOENT') })],
        })]);

        // 重启不重试加载，如实再报一次同样的失败。
        const again = await backend.start();
        expect(again.error).toBe(status.error);
        expect(backend.getDiagnostics().startup).toHaveLength(2);
    });
});
