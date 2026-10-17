import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getProviderApiBaseInput,
    getProviderApiBaseOverride,
    normalizeProviderApiBase,
    resetProviderApiBaseCache,
    setProviderApiBaseOverride,
} from '../../../src/services/onlineMusic/providerApiBase';

// test/unit/services/providerApiBase.test.ts
// 用户在设置里手打的地址要能被整理成一个真正可用的基地址，而整理规则里每一条都对应一个
// 具体后果：补错协议会得到一个被明文策略拒绝的地址，把非法输入落盘会让配置再也改不回来。
//
// 单测跑在 node 环境（vitest.config.ts 的 environment: 'node'），没有 localStorage，
// 所以存储是注入的内存实现，不依赖具体运行环境。

const createMemoryStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
        get length() { return map.size; },
        clear: () => { map.clear(); },
        getItem: (key: string) => map.get(key) ?? null,
        key: (index: number) => Array.from(map.keys())[index] ?? null,
        removeItem: (key: string) => { map.delete(key); },
        setItem: (key: string, value: string) => { map.set(key, String(value)); },
    } as Storage;
};

describe('normalizeProviderApiBase', () => {
    it('keeps a plain https address and drops trailing slashes', () => {
        expect(normalizeProviderApiBase('https://api.example.com/')).toBe('https://api.example.com');
        expect(normalizeProviderApiBase('https://api.example.com///')).toBe('https://api.example.com');
    });

    it('assumes https when the user typed only a host', () => {
        // 补 https 而不是 http：http 的网关在安卓壳里会被明文策略拒绝，静默补 http 只会给出一个必然失败的地址。
        expect(normalizeProviderApiBase('api.example.com')).toBe('https://api.example.com');
        expect(normalizeProviderApiBase('  api.example.com:3000  ')).toBe('https://api.example.com:3000');
    });

    it('keeps an explicit http address, because a LAN instance needs one', () => {
        expect(normalizeProviderApiBase('http://192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    });

    it('preserves a path prefix', () => {
        expect(normalizeProviderApiBase('https://example.com/netease/')).toBe('https://example.com/netease');
    });

    it('rejects an unsupported scheme instead of inventing a host for it', () => {
        expect(normalizeProviderApiBase('ftp://example.com')).toBeNull();
        expect(normalizeProviderApiBase('file:///tmp/api')).toBeNull();
    });

    it('treats empty and non-string input as "not configured"', () => {
        expect(normalizeProviderApiBase('')).toBeNull();
        expect(normalizeProviderApiBase('   ')).toBeNull();
        expect(normalizeProviderApiBase(undefined)).toBeNull();
        expect(normalizeProviderApiBase(null)).toBeNull();
    });
});

describe('provider api base override', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createMemoryStorage());
        resetProviderApiBaseCache();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('round-trips a normalized address and seeds the input box with it', () => {
        expect(setProviderApiBaseOverride('netease', 'api.example.com')).toBe('https://api.example.com');
        expect(getProviderApiBaseOverride('netease')).toBe('https://api.example.com');
        // 落盘的是整理后的地址，输入框读回来也是它：设置界面保存成功后回显的正是"系统实际会
        // 请求什么"，而不是用户原本打的那串。
        expect(getProviderApiBaseInput('netease')).toBe('https://api.example.com');
    });

    it('does not write an unusable address over a working one', () => {
        setProviderApiBaseOverride('netease', 'https://good.example.com');
        expect(setProviderApiBaseOverride('netease', 'ftp://nope')).toBeNull();
        // 坏输入被拒绝，上一次可用的值留着——写坏配置比报错更难恢复。
        expect(getProviderApiBaseOverride('netease')).toBe('https://good.example.com');
    });

    it('clears the override on empty input', () => {
        setProviderApiBaseOverride('netease', 'https://good.example.com');
        expect(setProviderApiBaseOverride('netease', '   ')).toBeNull();
        expect(getProviderApiBaseOverride('netease')).toBeNull();
        expect(getProviderApiBaseInput('netease')).toBe('');
    });

    it('scopes the address to its own provider', () => {
        setProviderApiBaseOverride('netease', 'https://netease.example.com');
        expect(getProviderApiBaseOverride('qq')).toBeNull();
    });
});
