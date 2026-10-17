import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/debug/incidents.test.ts
// 黑屏事故日志。这个模块的存在理由是「这台设备没有 console」，所以它的容错方向只有一条：
// 无论存储怎么坏、写不进去还是写不进去，它都不能在 import 时抛 —— 那会让应用在启动时就死。
// 同时它必须真的留下证据：跨重载之后还能读到上一次会话里的那几条。

describe('incident log', () => {
    let values: Map<string, string>;

    const installStorage = (throwOnRead = false, throwOnWrite = false) => {
        const storage = {
            getItem: (key: string) => {
                if (throwOnRead) throw new Error('blocked');
                return values.get(key) ?? null;
            },
            setItem: (key: string, value: string) => {
                if (throwOnWrite) throw new Error('blocked');
                values.set(key, value);
            },
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        vi.resetModules();
    };

    beforeEach(() => {
        values = new Map();
        installStorage();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    const load = async () => import('@/services/debug/incidents');

    it('记录之后能按顺序读回，最新的一条在最后', async () => {
        const incidents = await load();
        incidents.recordIncident('error', 'first');
        incidents.recordIncident('gl-lost', 'canvas 640x360');

        expect(incidents.readIncidents().map(entry => entry.detail)).toEqual(['first', 'canvas 640x360']);
        expect(incidents.lastIncident()?.kind).toBe('gl-lost');
        expect(incidents.lastIncident('error')?.detail).toBe('first');
    });

    it('detail 里的换行和多余空白会被压平并截断', async () => {
        const incidents = await load();
        expect(incidents.clipDetail('  a\n\n  b\tc  ')).toBe('a b c');

        const long = 'x'.repeat(incidents.INCIDENT_LIMITS.DETAIL_MAX + 50);
        const clipped = incidents.clipDetail(long);
        expect(clipped.length).toBe(incidents.INCIDENT_LIMITS.DETAIL_MAX);
        expect(clipped.endsWith('…')).toBe(true);
    });

    it('环形缓冲只保留最近 CAPACITY 条', async () => {
        const incidents = await load();
        const total = incidents.INCIDENT_LIMITS.CAPACITY + 7;
        for (let index = 0; index < total; index += 1) {
            incidents.recordIncident('error', `e${index}`);
        }

        const log = incidents.readIncidents();
        expect(log.length).toBe(incidents.INCIDENT_LIMITS.CAPACITY);
        expect(log[log.length - 1].detail).toBe(`e${total - 1}`);
        expect(log[0].detail).toBe(`e${total - incidents.INCIDENT_LIMITS.CAPACITY}`);
    });

    it('落盘只保留尾部 PERSISTED 条，并且跨重载还能读到', async () => {
        const incidents = await load();
        const total = incidents.INCIDENT_LIMITS.PERSISTED + 5;
        for (let index = 0; index < total; index += 1) {
            incidents.recordIncident('rejection', `r${index}`);
        }

        const stored = JSON.parse(values.get(incidents.INCIDENT_LIMITS.STORAGE_KEY)!) as unknown[];
        expect(stored.length).toBe(incidents.INCIDENT_LIMITS.PERSISTED);

        vi.resetModules();
        const reloaded = (await import('@/services/debug/incidents'));
        expect(reloaded.readIncidents().length).toBe(incidents.INCIDENT_LIMITS.PERSISTED);
        expect(reloaded.readIncidents().at(-1)?.detail).toBe(`r${total - 1}`);
    });

    it('存储里是垃圾时当作空日志，而不是让 import 抛', async () => {
        values.set('folia_incidents', '{not json');
        installStorage();
        const incidents = await load();
        expect(incidents.readIncidents()).toEqual([]);

        values.set('folia_incidents', JSON.stringify({ wrong: 'shape' }));
        installStorage();
        expect((await load()).readIncidents()).toEqual([]);
    });

    it('单条形状不对只丢这一条，其余照读', async () => {
        values.set('folia_incidents', JSON.stringify([
            { at: 1, kind: 'error', detail: 'good' },
            { at: 'x', kind: 'error', detail: 'bad at' },
            { at: 2, kind: 'nonsense', detail: 'bad kind' },
            null,
            { at: 3, kind: 'gl-lost', detail: 42 },
        ]));
        installStorage();
        const incidents = await load();

        const log = incidents.readIncidents();
        expect(log.map(entry => entry.detail)).toEqual(['good', '']);
        expect(log[1].kind).toBe('gl-lost');
    });

    it('写不进去时不抛，本次会话仍然记得', async () => {
        installStorage(false, true);
        const incidents = await load();

        expect(() => incidents.recordIncident('error', 'still counted')).not.toThrow();
        expect(incidents.readIncidents().map(entry => entry.detail)).toEqual(['still counted']);
    });

    it('读不到存储时也能用', async () => {
        installStorage(true);
        const incidents = await load();
        incidents.recordIncident('blank-root', 'root empty');
        expect(incidents.countIncidents('blank-root')).toBe(1);
    });

    it('订阅只在有新记录时被通知，取消后不再收到', async () => {
        const incidents = await load();
        const listener = vi.fn();
        const unsubscribe = incidents.subscribeToIncidents(listener);

        incidents.recordIncident('error', 'one');
        expect(listener).toHaveBeenCalledTimes(1);

        // 没有新记录时读快照必须是同一个引用，否则 HUD 每 500ms 都会白白重渲染。
        const before = incidents.readIncidents();
        expect(incidents.readIncidents()).toBe(before);

        unsubscribe();
        incidents.recordIncident('error', 'two');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('countContextLosses 分开统计丢失与恢复', async () => {
        const incidents = await load();
        incidents.recordIncident('gl-lost', 'canvas');
        incidents.recordIncident('gl-lost', 'canvas');
        incidents.recordIncident('gl-restored', 'canvas');

        expect(incidents.countContextLosses()).toEqual({ lost: 2, restored: 1 });
    });

    it('clearIncidents 清空内存与存储', async () => {
        const incidents = await load();
        incidents.recordIncident('error', 'bye');
        incidents.clearIncidents();

        expect(incidents.readIncidents()).toEqual([]);
        expect(JSON.parse(values.get(incidents.INCIDENT_LIMITS.STORAGE_KEY)!)).toEqual([]);
    });
});
