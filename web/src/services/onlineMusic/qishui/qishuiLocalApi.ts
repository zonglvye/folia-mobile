// src/services/onlineMusic/qishui/qishuiLocalApi.ts
//
// 汽水（qishui）在手机壳里的落地层，三件事：
//
//   1. 把 qishui-music-api 这个 Node 包跑起来（它的 node:crypto 由 qishuiNodeCrypto 顶替；
//      那个模块必须第一个 import —— 它顺带把 `Buffer` 装到 globalThis 上）。
//   2. 账号存 localStorage（上游用 electron-store + safeStorage 加密，手机这边没有等价物，
//      等价于浏览器的 cookie：只在本机、只在本 App 的源里）。
//   3. 所有 HTTP 都经壳的同源代理 `/api/lyric-proxy`：汽水的接口不带 CORS 头，页面直连会被拦。
//      壳那边为此加了三样东西（见 harmony 的 HttpProxy.ets）：域名白名单、POST 体、响应头透传——
//      最后一项是登录必需，ticket 在 `bd-ticket-guard-server-data` 响应头里，不在 body 里。
import './qishuiNodeCrypto';

import {
    createQishuiApi,
    createQishuiDeviceId,
    type QishuiBridgeResult,
    type QishuiOperation,
    type QishuiParams,
    type QishuiSession,
    type QishuiSessionStore,
} from 'qishui-music-api';

const DEVICE_KEY = 'qishui_device_id';
const SESSION_KEY = 'qishui_session_v1';
const LOG_PREFIX = '[Qishui]';

const readDeviceId = (): string => {
    if (typeof window === 'undefined') return createQishuiDeviceId();
    const stored = window.localStorage.getItem(DEVICE_KEY);
    if (stored && /^\d{19}$/.test(stored)) return stored;
    const created = createQishuiDeviceId();
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
};

let revision = 0;
let current: QishuiSession | null = null;
let loaded = false;

const sessions: QishuiSessionStore = {
    deviceId: readDeviceId(),
    get revision() { return revision; },
    get(): QishuiSession | null {
        if (!loaded) {
            loaded = true;
            try {
                const raw = window.localStorage.getItem(SESSION_KEY);
                if (raw) {
                    const value = JSON.parse(raw) as QishuiSession;
                    if (value && value.version === 1 && typeof value.ticket === 'string' && value.userId) current = value;
                }
            } catch {
                // 存档坏了就当没登录：不能让一条坏 JSON 把整个 provider 卡死。
                current = null;
            }
        }
        return current;
    },
    set(session: QishuiSession) {
        loaded = true;
        current = { ...session, version: 1 };
        revision += 1;
        try {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(current));
        } catch (error) {
            console.warn(`${LOG_PREFIX} account kept in memory only`, error);
        }
    },
    clear() {
        loaded = true;
        current = null;
        revision += 1;
        window.localStorage.removeItem(SESSION_KEY);
    },
};

/**
 * 登录链路的请求轨迹：只留形状不留值（路径、方法、发出去的头名、回来的顶层键与错误码）。
 * 扫码失败时上游只给一句「参数错误」，没有这个就只能猜；里面有 ticket / access_code 的值，
 * 所以一个都不记。在 devtools 里看 `__foliaQishui.trace()`。
 */
type QishuiLoginTrace = {
    at: number;
    path: string;
    method: string;
    headers: string[];
    /** 请求体里有哪些字段、是不是空的（只记形状，不记值）。 */
    body?: string[];
    status?: number;
    keys?: string[];
    /** 响应 data 里面那一层的键名（上游把错误放在 data.error_code 里）。 */
    innerKeys?: string[];
    errorCode?: number | string;
    errorText?: string;
};
const TRACE_PATHS = ['/passport/', '/access/', '/oauth/', '/me/info/'];
const loginTrace: QishuiLoginTrace[] = [];
const rememberTrace = (entry: QishuiLoginTrace) => {
    loginTrace.push(entry);
    while (loginTrace.length > 24) loginTrace.shift();
};
const traceOf = (response: Response, entry: QishuiLoginTrace) => {
    void response.clone().json().then((data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const record = data as Record<string, unknown>;
        const inner = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null;
        entry.keys = Object.keys(record).slice(0, 8);
        if (inner) entry.innerKeys = Object.keys(inner).slice(0, 20);
        const code = record.err_no ?? inner?.error_code;
        if (code !== undefined && Number(code) !== 0) entry.errorCode = code as number | string;
        const text = record.err_msg ?? inner?.description ?? record.message;
        if (typeof text === 'string' && text) entry.errorText = text.slice(0, 60);
    }).catch(() => {});
};

/** 请求体的形状：字段名 + 该值是不是空的。凭据的值一个字符都不留。 */
const bodyShape = (body: unknown): string[] | undefined => {
    if (typeof body !== 'string' || body.length === 0) return undefined;
    const shape: string[] = [];
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        Object.keys(parsed).forEach(key => shape.push(`${key}:${String(parsed[key] ?? '').length ? 'set' : 'EMPTY'}`));
        return shape;
    } catch {
        // 表单体
    }
    new URLSearchParams(body).forEach((value, key) => shape.push(`${key}:${value.length ? 'set' : 'EMPTY'}`));
    return shape;
};

/**
 * 把一次 `fetch(url, init)` 翻成壳代理的一次调用。
 *
 * 方法、请求体、允许的请求头都塞进 query：页面只能给地址，壳再按白名单复核一遍
 * （能发哪些头、能发给哪些域名，都是壳说了算）。
 */
const proxiedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const absolute = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const params = new URLSearchParams({ url: absolute });
    if (method !== 'GET') params.set('method', method);
    const headerNames: string[] = [];
    if (init?.headers) {
        const table: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => { table[name] = value; });
        if (Object.keys(table).length) {
            params.set('headers', JSON.stringify(table));
            headerNames.push(...Object.keys(table));
        }
    }
    if (typeof init?.body === 'string' && init.body.length > 0) params.set('body', init.body);
    const traced = TRACE_PATHS.some(segment => absolute.includes(segment));
    const entry: QishuiLoginTrace | null = traced
        ? {
            at: Date.now(),
            path: absolute.split('?')[0].replace(/^https:\/\/[^/]+/, ''),
            method,
            headers: headerNames,
            ...(bodyShape(init?.body) ? { body: bodyShape(init?.body) } : {}),
        }
        : null;
    if (entry) rememberTrace(entry);
    // 这里用 window.fetch 而不是全局 fetch：它已经被 shellFetchProxy 接管，会把请求送到桥上。
    const response = await fetch(`/api/lyric-proxy?${params.toString()}`);
    if (entry) {
        entry.status = response.status;
        traceOf(response, entry);
    }
    return response;
};

const log = (message: string) => console.info(`${LOG_PREFIX} ${message}`);
const warn = (message: string) => console.warn(`${LOG_PREFIX} ${message}`);

const api = createQishuiApi({
    deviceId: sessions.deviceId,
    sessions,
    fetch: proxiedFetch as unknown as typeof globalThis.fetch,
    log,
    warn,
});

// 上游的桥给的是一次「操作 + 参数 → 结果信封」，这里保持同样的形状，provider 那层照抄即可。
export const requestQishuiBridge = async (
    operation: QishuiOperation,
    params: QishuiParams = {},
): Promise<QishuiBridgeResult> => api.request(operation, params);

/**
 * 有没有「汽水」这个能力：只有在装上了壳代理的环境（鸿蒙/安卓壳）里才有意义。
 * 浏览器里没有同源代理，请求会打到部署端的 `/api/lyric-proxy`（那边不认汽水的域名），所以直接报不可用。
 */
export const getQishuiAvailability = () => {
    const bridge = typeof window === 'undefined'
        ? undefined
        : (window as { foliaAndroid?: { proxyStart?: unknown } }).foliaAndroid;
    return typeof bridge?.proxyStart === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const;
};

// 真机排查用：在 devtools 里直接敲 `__foliaQishui.request('search', { query: '陈奕迅' })`，
// 就能看这一步是不是通的（不经过 UI）。壳里的日志通道读不到页面 console，这个是唯一的窗口。
// `trace()` 是登录链路最近 24 次请求的形状（没有凭据的值），扫码失败时看它。
if (typeof window !== 'undefined') {
    (window as unknown as { __foliaQishui?: unknown }).__foliaQishui = {
        request: requestQishuiBridge,
        availability: getQishuiAvailability,
        reset: () => sessions.clear(),
        trace: () => loginTrace.slice(),
    };
}
