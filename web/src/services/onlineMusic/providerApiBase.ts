import type { OnlineProviderId } from '../../types/onlineMusic';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/providerApiBase.ts
// 在线音源的 API 网关地址，由用户在设置里填。上游把它做成了构建期环境变量
// （VITE_NETEASE_API_BASE），那是给自部署 Web 版用的；手机上装好的 APK 没法重新构建，
// 所以这里补一个运行时可改、可持久化的覆盖值。
//
// 优先级（见 netease.ts 的 getApiBase）：本机覆盖值 > 构建期环境变量。
// 覆盖值为空字符串时视为"没填"，回落到构建期值，而不是把地址清成非法值。
//
// 读取必须同步：getApiBase 在每次请求前调用它，不能变成 async。

/** 覆盖值变化时派发，用来让已经缓存过地址的调用方失效。 */
export const PROVIDER_API_BASE_CHANGED_EVENT = 'folia-provider-api-base-changed';

/** 存进 provider 会话命名空间的键（`online_provider:<provider>:apiBase`）。 */
const STORAGE_KEY = 'apiBase';

// 同步读取的缓存。localStorage 本身是同步的，但每次请求都读一次磁盘在切歌路径上不值得，
// 所以进程内留一份，并由事件与 setter 维护它。
const cache = new Map<string, string | null>();

const isSupportedScheme = (value: string): boolean => (
    value.startsWith('https://') || value.startsWith('http://')
);

/**
 * 把用户输入整理成一个可用的基地址，无法整理时返回 null。
 *
 * 容忍的是人打字的方式：两边空格、结尾多打的斜杠、只写域名不写协议。不猜的是协议——
 * 缺协议时补 https 而不是 http，因为 http 的网关在安卓壳里会被明文策略拒绝，静默补 http
 * 只会让用户拿到一个必然失败的地址。真要 http（局域网里的自建实例）就让他自己写出来。
 */
export const normalizeProviderApiBase = (raw: string | null | undefined): string | null => {
    if (typeof raw !== 'string') return null;
    let value = raw.trim();
    if (!value) return null;
    if (!isSupportedScheme(value)) {
        // 已经写了别的协议（ftp://、file://）就不能当作缺协议来补，那会拼出一个假地址。
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
        value = `https://${value}`;
    }
    value = value.replace(/\/+$/, '');
    try {
        const parsed = new URL(value);
        if (!parsed.hostname) return null;
        return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
        return null;
    }
};

/** 本机填的覆盖值；没填或填得不合法时为 null。 */
export const getProviderApiBaseOverride = (provider: OnlineProviderId): string | null => {
    if (cache.has(provider)) return cache.get(provider) ?? null;
    const stored = readProviderSessionValue(provider, STORAGE_KEY);
    const normalized = normalizeProviderApiBase(stored);
    cache.set(provider, normalized);
    return normalized;
};

/** 用户原始输入（未整理），给设置界面回显用；格式化后的地址不适合放回输入框。 */
export const getProviderApiBaseInput = (provider: OnlineProviderId): string => (
    readProviderSessionValue(provider, STORAGE_KEY) ?? ''
);

/**
 * 写入覆盖值。返回整理后的地址，或 null 表示这次输入无效或等于清空——两种情况调用方都要
 * 让输入框回显真实状态，而不是把用户打错的东西留在框里假装保存成功了。
 */
export const setProviderApiBaseOverride = (
    provider: OnlineProviderId,
    raw: string | null | undefined,
): string | null => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const normalized = normalizeProviderApiBase(trimmed);
    if (!normalized) {
        // 非法输入不落盘：留着上一次可用的值，比把配置写坏更可恢复。
        if (trimmed) return null;
        cache.set(provider, null);
        removeProviderSessionValue(provider, STORAGE_KEY);
        announce(provider, null);
        return null;
    }
    cache.set(provider, normalized);
    writeProviderSessionValue(provider, STORAGE_KEY, normalized);
    announce(provider, normalized);
    return normalized;
};

const announce = (provider: OnlineProviderId, value: string | null): void => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(PROVIDER_API_BASE_CHANGED_EVENT, {
        detail: { provider, apiBase: value },
    }));
};

/**
 * 订阅变化。回调用不到事件参数——调用方要的是"该重读了"，地址自己会再问一次。
 * 同时监听 storage 事件：另一个标签页改了地址，这个标签页的缓存也得失效。
 */
export const subscribeProviderApiBaseChanges = (
    listener: (provider: OnlineProviderId) => void,
): (() => void) => {
    if (typeof window === 'undefined') return () => undefined;

    const handleCustom = (event: Event) => {
        const detail = (event as CustomEvent<{ provider?: OnlineProviderId; }>).detail;
        if (detail?.provider) listener(detail.provider);
    };
    const handleStorage = (event: StorageEvent) => {
        if (!event.key || !event.key.endsWith(`:${STORAGE_KEY}`)) return;
        // key 形如 online_provider:<provider>:apiBase
        const provider = event.key.split(':')[1] as OnlineProviderId | undefined;
        if (!provider) return;
        cache.delete(provider);
        listener(provider);
    };

    window.addEventListener(PROVIDER_API_BASE_CHANGED_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
        window.removeEventListener(PROVIDER_API_BASE_CHANGED_EVENT, handleCustom);
        window.removeEventListener('storage', handleStorage);
    };
};

/** 测试用：清掉进程内缓存，让下一次读取回到 localStorage。 */
export const resetProviderApiBaseCache = (): void => {
    cache.clear();
};

// ---- 生效地址与来源 -------------------------------------------------------------------

/**
 * 构建期写死的网关地址（自部署 Web 版用 `VITE_*_API_BASE` 注入）。
 *
 * 这里刻意做成静态映射而不是 `import.meta.env[`VITE_${provider}_API_BASE`]`：Vite 只替换
 * 字面量成员访问，动态键在构建产物里会变成 undefined，配置会静默失效。
 */
const BUILD_TIME_API_BASE: Partial<Record<OnlineProviderId, string | undefined>> = {
    netease: (() => {
        const viteEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
        if (viteEnv && typeof viteEnv.VITE_NETEASE_API_BASE === 'string' && viteEnv.VITE_NETEASE_API_BASE) {
            return viteEnv.VITE_NETEASE_API_BASE as string;
        }
        if (typeof process !== 'undefined' && typeof process.env?.VITE_NETEASE_API_BASE === 'string') {
            return process.env.VITE_NETEASE_API_BASE;
        }
        return undefined;
    })(),
};

export const getBuildTimeApiBase = (provider: OnlineProviderId): string | null => {
    const value = BUILD_TIME_API_BASE[provider];
    return typeof value === 'string' && value ? value : null;
};

export type ProviderApiBaseSource = 'electron' | 'runtime' | 'build' | 'unset';

/**
 * 当前真正生效的地址，以及它是从哪来的。四态必须分开，因为对用户来说这是四件不同的事：
 * 桌面版根本没有地址可填、本机填了一个、构建时写死了一个、什么都没配。合成一句「未配置」
 * 会让人不知道该去哪里改。
 *
 * 桌面版判断只问"有没有 Electron 桥"，不问具体某个后端端口——这里回答的是"哪套配置在生效"，
 * 而不是"后端此刻是否就绪"，后者是 transport 自己的事。
 */
export const describeProviderApiBase = (provider: OnlineProviderId): {
    apiBase: string | null;
    source: ProviderApiBaseSource;
} => {
    if (typeof window !== 'undefined' && window.electron) return { apiBase: null, source: 'electron' };
    const override = getProviderApiBaseOverride(provider);
    if (override) return { apiBase: override, source: 'runtime' };
    const built = getBuildTimeApiBase(provider);
    if (built) return { apiBase: built, source: 'build' };
    return { apiBase: null, source: 'unset' };
};
