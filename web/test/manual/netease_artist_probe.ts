import process from 'node:process';

// test/manual/netease_artist_probe.ts
//
// 直接把本机实现的 artist 三条路由打到真的网易上，看响应形态。
//
// 为什么需要它：`neteaseLocalApi` 是照着参考实现（@neteasecloudmusicapienhanced/api 的
// module/artist_*.js）翻译的，但「路径对不对」和「上游认不认」只有真请求能回答，而这个 App
// 的本地实现没有可用的实例后端可以对着比。手机的壳里同样的活由 NeteaseProxyHandler.java 干，
// 这里用一个 fetch 垫片重做一遍：拆信封、发真 POST、包回 JSON 信封。
//
// 用法（出口 IP 在境外时网易可能拒绝游客注册，但这三条路由仍然会回 200）：
//   npx tsx test/manual/netease_artist_probe.ts [artistId]
//
// 已知结论（2026-10-17，id=6452 周杰伦）：
//   /artist/detail    → {code:200, data:{artist:{...}}}，cover/avatar 是 http://，由 netease.ts 改 https
//   /artist/album     → {code:200, artist:{...}, hotAlbums:[...], more:bool}
//   /artist/top/song  → {code:200, songs:[...], more:bool, privileges:[...]}

const realFetch = globalThis.fetch;
const store = new Map<string, string>();

// 会话与设备身份都读 localStorage；navigator 只是设备档案里的一份材料。
const installShims = () => {
    const localStorageShim = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => store.clear(),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() { return store.size; },
    };
    (globalThis as any).localStorage = localStorageShim;
    (globalThis as any).window = { localStorage: localStorageShim };
    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 14) FoliaProbe' };
    }
};

/** 壳里 NeteaseProxyHandler 的等价物：页面只发信封，原生侧发真请求。 */
const installProxyShim = () => {
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = new URL(String(input), 'https://appassets.androidplatform.net');
        if (url.pathname !== '/api/netease-proxy') {
            return realFetch(input, init);
        }
        const target = url.searchParams.get('url') ?? '';
        const body = url.searchParams.get('body') ?? '';
        const cookie = url.searchParams.get('cookie') ?? '';
        const userAgent = url.searchParams.get('ua') ?? '';
        const referer = url.searchParams.get('referer') ?? '';

        const headers: Record<string, string> = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent,
        };
        if (cookie) headers.Cookie = cookie;
        if (referer) headers.Referer = referer;

        const response = await realFetch(target, { method: 'POST', headers, body });
        const text = await response.text();
        const setCookie = (response.headers as any).getSetCookie?.().join('; ')
            ?? response.headers.get('set-cookie')
            ?? '';
        return new Response(JSON.stringify({ status: response.status, cookie: setCookie, body: text }), { status: 200 });
    };
};

const main = async () => {
    installShims();
    installProxyShim();

    const artistId = process.argv[2] ?? '6452';
    const { requestLocalNetease } = await import('../../src/services/onlineMusic/neteaseLocalApi');

    const probes: [string, string][] = [
        [`/artist/detail?id=${artistId}`, 'artist/detail'],
        [`/artist/album?id=${artistId}&limit=5&offset=0`, 'artist/album'],
        [`/artist/top/song?id=${artistId}`, 'artist/top/song'],
    ];

    for (const [endpoint, label] of probes) {
        const started = Date.now();
        try {
            const data: any = await requestLocalNetease(endpoint);
            console.log(`\n=== ${label} (${Date.now() - started}ms) code=${data?.code}`);
            console.log(JSON.stringify(data).slice(0, 600));
            if (data?.code === 404) {
                console.log('!! 还是未实现路由的 404 形态：路由表里没有这一条');
            }
        } catch (error) {
            console.log(`\n=== ${label} FAILED`);
            console.log(String(error));
        }
    }
};

void main().catch(error => {
    console.error('probe crashed', error);
    process.exitCode = 1;
});
