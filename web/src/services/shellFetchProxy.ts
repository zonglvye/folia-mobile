// src/services/shellFetchProxy.ts
//
// 打包壳里的同源代理通道。
//
// 背景：web 构建把酷狗/QQ/网易那些"没有 CORS 头的主机"的请求都写成同源的
// `/api/lyric-proxy?url=…` 与 `/api/netease-proxy?…`。网页形态下由部署端的函数应答；安卓壳里由
// Java 的 WebResourceLoader 拦截应答；鸿蒙壳里**不能**沿用拦截：ArkWeb 的 onInterceptRequest
// 回调是同步的，而这两个代理都要联网 —— 先返回空响应、稍后 setResponseData 回填的写法在真机上
// 页面拿到的是空 body（实测：壳这边 `code=200 dataReady=true`，页面却报"登录错误"、二维码不出来，
// 而且之后一次代理请求都没有再发）。
//
// 所以鸿蒙壳改成异步桥方法 `proxyFetch(url) -> Promise<json>`，这个模块把 `window.fetch` 接到它
// 上面。拦截那一侧被绕开，请求天然等得到上游。
//
// 只有桥明确提供 `proxyFetch` 时才接管。浏览器、桌面 Electron、安卓壳都没有这个方法，行为完全不变。

/** 壳返回的一次代理结果。字段名是壳与页面之间的 wire format（见 shell/HttpProxy.ets）。 */
export type ShellProxyResult = {
    status: number;
    mime: string;
    charset: string;
    /** 响应体的 base64。封面是二进制、歌词是文本，统一走 base64 就不用分两套。 */
    body: string;
    /**
     * 上游响应头，JSON 字符串（壳按白名单过滤过）。
     * 汽水的登录票据就在 `bd-ticket-guard-server-data` 这个响应头里，body 中没有。
     * 老版本壳不带这个字段，所以这里可选。
     */
    headers?: string;
};

type ProxyFetchBridge = {
    /** 发起一次代理请求，立刻返回 id；结果靠 proxyPoll 取。 */
    proxyStart?: (requestUrl: string) => number;
    /** 取结果：空串表示还在取。拿到之后壳会丢掉它。 */
    proxyPoll?: (id: number) => string;
    /** 页面侧的日志通道（ArkTS 的 console 在真机上读不出来，见壳里的 ShellLog）。 */
    report?: (level: string, message: string) => void;
};

/** 轮询间隔与上限。代理本身有 10s/20s 的连接/读超时，这里留出余量。 */
const POLL_INTERVAL_MS = 40;
const POLL_TIMEOUT_MS = 30000;

/** 需要接管的同源路径。改这里就要同步改 Android 壳与 api-ts 的路由。 */
const PROXY_PATHS = ['/api/lyric-proxy', '/api/netease-proxy'];

let installed = false;

const readBridge = (): ProxyFetchBridge | undefined => (
    typeof window === 'undefined'
        ? undefined
        : (window as { foliaAndroid?: ProxyFetchBridge }).foliaAndroid
);

const requestUrlOf = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
    return (input as Request).url;
};

const base64ToBytes = (base64: string): Uint8Array => {
    if (!base64) return new Uint8Array(0);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

const buildResponse = (result: ShellProxyResult): Response => {
    const headers = new Headers();
    if (result.mime) {
        headers.set(
            'content-type',
            result.charset ? `${result.mime}; charset=${result.charset}` : result.mime,
        );
    }
    // 上游响应头先铺一层，再把 content-type 覆盖成壳整理过的那份：汽水要靠
    // bd-ticket-guard-server-data 拿 ticket，页面这边必须能 headers.get 到它。
    if (result.headers) {
        try {
            const parsed = JSON.parse(result.headers) as Record<string, string>;
            Object.keys(parsed).forEach((name) => {
                if (name.toLowerCase() === 'content-type') return;
                headers.set(name, parsed[name]);
            });
        } catch {
            // 头不合法不该让整次请求失败：正文已经拿到了。
        }
    }
    // 交给 Response 的是一段独立的 ArrayBuffer：Uint8Array 可能是 SharedArrayBuffer 支撑的视图，
    // 那样不满足 BodyInit（tsc 会拒），顺手也省掉一次拷贝歧义。
    const bytes = base64ToBytes(result.body);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(buffer, { status: result.status, headers });
};

/**
 * 装上 fetch 补丁，返回是否装上了（没有桥就是 false，调用方一般不需要关心）。
 * 幂等：重复调用只装一次。
 */
export const installShellFetchProxy = (): boolean => {
    if (installed) return true;

    const bridge = readBridge();
    if (typeof bridge?.proxyStart !== 'function' || typeof bridge.proxyPoll !== 'function') {
        return false;
    }
    const proxyStart = bridge.proxyStart.bind(bridge);
    const proxyPoll = bridge.proxyPoll.bind(bridge);

    /**
     * 一次代理请求 = proxyStart + 轮询 proxyPoll。
     *
     * 为什么是轮询而不是 async 桥方法：真机上 asyncMethodList 注册的方法确实被调到、上游也确实
     * 成功，但页面这边的 Promise 永远不 resolve（壳日志里只有 `proxy ->` 没有 `proxy <-`）。
     * 同步方法在这个桥上是确定可用的，所以把它拆成"发起 + 取结果"两步。
     */
    const runProxy = async (absolute: string): Promise<ShellProxyResult> => {
        // 明确离线时不要往壳里送：壳会先等中继页 20 秒超时、再退回系统网络栈 30 秒，
        // 用户要等将近一分钟才看到失败。这里直接按浏览器联网失败抛，上层按 network 处理。
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new TypeError('Failed to fetch');
        }
        const id = proxyStart(absolute);
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const raw = proxyPoll(id);
            if (raw) {
                return JSON.parse(raw) as ShellProxyResult;
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error('shell proxy timed out');
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        let absolute: string;
        try {
            absolute = new URL(requestUrlOf(input), document.baseURI).href;
        } catch {
            return originalFetch(input, init);
        }

        if (!PROXY_PATHS.some(path => absolute.includes(path))) {
            return originalFetch(input, init);
        }

        // 代理只发 GET（见 neteaseEapiTransport：上游方法、表单体、Cookie 都在 query 里），
        // 所以 init 不参与，也不该参与。
        return runProxy(absolute).then(result => {
            const response = buildResponse(result);
            bridge.report?.('I', `proxy <- ${result.status} ${result.mime} base64=${result.body.length}`);
            return response;
        }).catch(error => {
            bridge.report?.('E', `proxy threw: ${absolute.slice(0, 100)} ${String(error).slice(0, 120)}`);
            throw error;
        });
    };
    installed = true;
    return true;
};
