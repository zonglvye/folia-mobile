import md5 from 'blueimp-md5';

import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';
import { adoptNeteaseDeviceId, createNeteaseDeviceId, resolveNeteaseDeviceProfile } from './neteaseDeviceProfile';
import { buildNeteaseQrLoginUrl, renderNeteaseQrDataUrl } from './neteaseQrImage';
import {
    callNeteaseEapi,
    callNeteaseWeapi,
    type NeteaseCookieJar,
    type NeteaseSession,
} from './neteaseEapiTransport';

// src/services/onlineMusic/neteaseLocalApi.ts

/**
 * 把“远程网易云 API 实例”搬进 App 内部，这样手机端不需要任何自建后端。
 *
 * 这个文件扮演的是 `@neteasecloudmusicapienhanced/api` 那一层：App 现在打的是
 * `/cloudsearch?keywords=…` 这样的普通 JSON 接口，远端实例负责翻译成 eapi/weapi 并加密。
 * 壳里没有实例，所以这些路由在这里实现，响应形态与实例逐个对齐（`shape` 里逐条注明），
 * `services/netease.ts` 完全不用改。
 *
 * 分期范围：扫码登录、登录态、搜索、歌曲详情、播放地址、歌词、歌手页（详情 / 专辑 / 热门歌曲）。
 * 其余路由返回 `{code:404,msg:'Not Found',data:null}`——与真实实例的“没有这个路由”同形，现有代码靠
 * `isNeteaseRouteMissingResponse` 识别它的降级路径照旧工作。
 *
 * 一个已知的取舍：`/song/url/v1` 和 `/register/anonimous` 在参考实现里默认走 xeapi
 * （X25519 + AES-GCM），这里走 eapi。换方案是因为 eapi 的实现已被单测钉住并与参考实现逐字节一致，
 * 而 xeapi 还需要从服务端侧获取公钥。能不能被接受只有真机能回答；被风控拦下时不要在这里硬凑。
 */

/** 应用侧会话 cookie 与游客 cookie 的存储位，和 `services/netease.ts` 用的是同一套 key。 */
const COOKIE_KEY = 'cookie';
const ANONYMOUS_COOKIE_KEY = 'anonymous_cookie';

/** 游客注册的 deviceId 混淆密钥，来自参考实现的 `register_anonimous.js`。 */
const ANONYMOUS_ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';

type NeteaseRoute = {
    /** 上游加密方式。 */
    mode: 'eapi' | 'weapi';
    /**
     * 上游路径，含 `/api/` 前缀——它是 eapi 签名材料的一部分。
     *
     * 少数路由把 id 放在路径里（`/api/artist/albums/{id}`），所以这里允许一个函数，
     * 拿应用侧 query 拼出真实路径。
     */
    uri: string | ((query: URLSearchParams) => string);
    /** 应用侧 query → 上游 payload。 */
    payload: (query: URLSearchParams) => Record<string, unknown>;
    /** 上游 body → 应用侧期望的响应形态；缺省原样返回。 */
    shape?: (data: any, cookie: string) => unknown;
    /** 请求前是否先确保有游客会话；登录/账户类路由设为 false。 */
    needsAnonymous?: boolean;
    /** 该路由会顺带换掉本机 deviceId，需要在组完 payload 之后重新读一次设备身份。 */
    regeneratesDeviceId?: boolean;
};

const readNumber = (value: string | null, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** 允许 `0` 的整数读取：分页的 offset 就是 0 起算，`readNumber` 会把它当成没给。 */
const readOffset = (value: string | null): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const resolveRouteUri = (route: NeteaseRoute, query: URLSearchParams): string => (
    typeof route.uri === 'function' ? route.uri(query) : route.uri
);

/** 把 `k=v; k=v`（或实例返回的 `k=v;k=v`）读成对象；空值表示删除。 */
export const parseCookieString = (text: string | null | undefined): NeteaseCookieJar => {
    const jar: NeteaseCookieJar = {};
    if (!text) return jar;
    for (const part of text.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const equals = trimmed.indexOf('=');
        if (equals <= 0) continue;
        const name = trimmed.slice(0, equals).trim();
        if (!name) continue;
        jar[name] = trimmed.slice(equals + 1).trim();
    }
    return jar;
};

export const serializeCookieJar = (jar: NeteaseCookieJar): string => (
    Object.entries(jar)
        .filter(([name, value]) => Boolean(name) && typeof value === 'string' && value !== '')
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
);

/**
 * 合并上游 Set-Cookie：值为空的条目按删除处理。
 *
 * 退出登录靠的正是这一条——网易清 `MUSIC_U` 用的是 `Max-Age=0`，壳把它拉平成 `MUSIC_U=`，
 * 忽略这个空值会让用户退出之后仍然带着旧会话。
 */
const mergeSetCookies = (jar: NeteaseCookieJar, setCookies: string): NeteaseCookieJar => {
    const merged: NeteaseCookieJar = { ...jar };
    for (const [name, value] of Object.entries(parseCookieString(setCookies))) {
        if (value === '') {
            delete merged[name];
        } else {
            merged[name] = value;
        }
    }
    return merged;
};

const loadSession = (): NeteaseSession => ({
    profile: resolveNeteaseDeviceProfile(),
    jar: parseCookieString(readProviderSessionValue('netease', COOKIE_KEY, ['netease_cookie'])),
});

/**
 * 上一次写进存储的 cookie 串。
 *
 * `localStorage.setItem` 是同步的，会参与主线程的样式/脚本调度；而播放一首歌就要走
 * 详情 + 播放地址 + 歌词三次请求，每次原样重写一遍同样的字符串纯属浪费。
 * 只在内容真的变了的时候写。
 */
let lastPersistedCookie: string | null = null;

/** 把 jar 写回存储；顺便让诊断里的“anonymous cookie”一栏说实话。 */
const persistSession = (session: NeteaseSession): void => {
    const serialized = serializeCookieJar(session.jar);
    if (serialized !== lastPersistedCookie) {
        if (serialized) {
            writeProviderSessionValue('netease', COOKIE_KEY, serialized);
        } else {
            removeProviderSessionValue('netease', COOKIE_KEY, ['netease_cookie']);
        }
        lastPersistedCookie = serialized;
    }
    if (session.jar.MUSIC_A && !session.jar.MUSIC_U) {
        writeProviderSessionValue('netease', ANONYMOUS_COOKIE_KEY, session.jar.MUSIC_A);
    }
};

/** 32 位小写十六进制 MD5 转 Base64（参考实现里用的是 CryptoJS 的 `WordArray` + Base64）。 */
const md5Base64 = (text: string): string => {
    const hex = md5(text);
    let binary = '';
    for (let index = 0; index < hex.length; index += 2) {
        binary += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
    }
    return btoa(binary);
};

/** 把 deviceId 逐字符与密钥异或后取 MD5-Base64，与客户端的 `cloudmusic_dll_encode_id` 一致。 */
const encodeAnonymousDeviceId = (deviceId: string): string => {
    let xored = '';
    for (let index = 0; index < deviceId.length; index += 1) {
        xored += String.fromCharCode(
            deviceId.charCodeAt(index) ^ ANONYMOUS_ID_XOR_KEY.charCodeAt(index % ANONYMOUS_ID_XOR_KEY.length),
        );
    }
    return md5Base64(xored);
};

/**
 * 游客注册的 `username`：`base64("<新deviceId> <混淆后的deviceId>")`。
 *
 * 顺带把新 deviceId 落盘：参考实现也是注册时现生成一个并立刻给后续请求用，
 * 不落盘的话每个请求的设备身份会开始漂移。
 */
const buildAnonymousUsername = (): string => {
    const deviceId = createNeteaseDeviceId();
    adoptNeteaseDeviceId(deviceId);
    return btoa(`${deviceId} ${encodeAnonymousDeviceId(deviceId)}`);
};

/** 播放地址必须走 https：页面在 https 源上，http 音频会被当成混合内容直接拦掉。 */
const rewriteSongUrlProtocols = (data: any): any => {
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
        ...data,
        data: items.map((item: any) => ({
            ...item,
            url: typeof item?.url === 'string' ? item.url.replace(/^http:/, 'https:') : item?.url,
            proxyUrl: typeof item?.proxyUrl === 'string' ? item.proxyUrl.replace(/^http:/, 'https:') : item?.proxyUrl,
        })),
    };
};

const ROUTES: Record<string, NeteaseRoute> = {
    '/cloudsearch': {
        mode: 'eapi',
        uri: '/api/cloudsearch/pc',
        payload: query => ({
            s: query.get('keywords') ?? '',
            type: readNumber(query.get('type'), 1),
            limit: readNumber(query.get('limit'), 30),
            offset: readNumber(query.get('offset'), 0),
            total: true,
        }),
    },
    '/song/detail': {
        mode: 'weapi',
        uri: '/api/v3/song/detail',
        // 上游要的是 `c=[{"id":1},{"id":2}]` 这种字符串，不是数组。
        payload: (query) => {
            const ids = (query.get('ids') ?? '').split(/\s*,\s*/).filter(Boolean).map(id => `{"id":${Number(id)}}`);
            return { c: `[${ids.join(',')}]` };
        },
    },
    '/lyric/new': {
        mode: 'eapi',
        uri: '/api/song/lyric/v1',
        payload: query => ({
            id: query.get('id'),
            cp: false,
            tv: 0,
            lv: 0,
            rv: 0,
            kv: 0,
            yv: 0,
            ytv: 0,
            yrv: 0,
        }),
    },
    '/song/url/v1': {
        mode: 'eapi',
        uri: '/api/song/enhance/player/url/v1',
        payload: query => ({
            ids: `[${query.get('id')}]`,
            level: query.get('level') || 'exhigh',
            encodeType: 'flac',
        }),
        shape: data => rewriteSongUrlProtocols(data),
    },
    // 实例在这里把上游 body 包一层：`{data: {code, unikey}, code: 200}`。provider 读的是 `data.unikey`。
    '/login/qr/key': {
        mode: 'eapi',
        uri: '/api/login/qrcode/unikey',
        payload: () => ({ type: 3 }),
        shape: data => ({ code: 200, data }),
        needsAnonymous: false,
    },
    // 实例把 Set-Cookie 拉平后塞进 `cookie` 字段，provider 靠它落盘登录态。
    '/login/qr/check': {
        mode: 'eapi',
        uri: '/api/login/qrcode/client/login',
        payload: query => ({ key: query.get('key'), type: 3 }),
        shape: (data, cookie) => ({ ...data, cookie }),
        needsAnonymous: false,
    },
    // 实例把上游 body 整个塞进 `data`，provider 读 `data.profile`。
    '/login/status': {
        mode: 'weapi',
        uri: '/api/w/nuser/account/get',
        payload: () => ({}),
        shape: (data, cookie) => (Number(data?.code) === 200 ? { data: { ...data }, cookie } : data),
        needsAnonymous: false,
    },
    '/user/account': {
        mode: 'weapi',
        uri: '/api/nuser/account/get',
        payload: () => ({}),
        shape: (data, cookie) => ({ ...data, cookie }),
        needsAnonymous: false,
    },
    '/logout': {
        mode: 'eapi',
        uri: '/api/logout',
        payload: () => ({}),
        needsAnonymous: false,
    },
    '/register/anonimous': {
        mode: 'eapi',
        uri: '/api/register/anonimous',
        payload: () => ({ username: buildAnonymousUsername() }),
        shape: (data, cookie) => ({ ...data, cookie }),
        needsAnonymous: false,
        regeneratesDeviceId: true,
    },

    // --- 曲库与账户 ---
    // 下面这批都是“原样透传上游 body”，消费方（netease.ts）自己会 mergeSongsWithPrivileges
    // 和把封面地址升到 https，所以这里不整形。
    '/user/playlist': {
        mode: 'weapi',
        uri: '/api/user/playlist',
        payload: query => ({
            uid: query.get('uid'),
            limit: readNumber(query.get('limit'), 30),
            offset: readNumber(query.get('offset'), 0),
            includeVideo: true,
        }),
    },
    '/likelist': {
        mode: 'eapi',
        uri: '/api/song/like/get',
        payload: query => ({ uid: query.get('uid') }),
    },
    '/like': {
        mode: 'eapi',
        uri: '/api/song/like',
        // 只有明确传 like=false 才是取消，缺省是收藏，与实例一致。
        payload: query => ({
            trackId: query.get('id'),
            userid: query.get('uid'),
            like: query.get('like') !== 'false',
        }),
    },
    '/personal_fm': {
        mode: 'weapi',
        uri: '/api/v1/radio/get',
        payload: () => ({}),
    },
    '/recommend/songs': {
        mode: 'weapi',
        uri: '/api/v3/discovery/recommend/songs',
        payload: query => ({ afresh: query.get('afresh') }),
    },
    '/playlist/detail': {
        mode: 'eapi',
        uri: '/api/v6/playlist/detail',
        payload: query => ({ id: query.get('id'), n: 100000, s: readNumber(query.get('s'), 8) }),
    },
    '/song/chorus': {
        mode: 'eapi',
        uri: '/api/song/chorus',
        payload: query => ({ ids: JSON.stringify([query.get('id')]) }),
    },

    // --- 歌手页 ------------------------------------------------------------------
    // 参考实现 module/artist_detail.js、artist_album.js、artist_top_song.js。
    //
    // 这三条之前整片缺失，而从搜索点进歌手页正好只打这三条：`/artist/detail` 拿封面与简介、
    // `/artist/album` 拿专辑列表、`/artist/top/song` 拿热门歌曲。缺了它们，页面拿到的是
    // `{code:404}`，展示出来就是「暂无内容」——而网易是本机的默认音源，所以歌手页整个是不可用的。
    //
    // 形态原样透传，和实例一致：`netease.ts` 读的是 `data.artist`、`hotAlbums`/`more`、`songs`/`privileges`。
    '/artist/detail': {
        // 参考实现用的是默认 crypto（实例配置 encrypt=true 时为 eapi），与这里其它路由一致。
        mode: 'eapi',
        uri: '/api/artist/head/info/get',
        payload: query => ({ id: query.get('id') }),
    },
    '/artist/album': {
        mode: 'weapi',
        // 歌手的 id 在路径里，不在 payload 里。
        uri: query => `/api/artist/albums/${query.get('id') ?? ''}`,
        payload: query => ({
            limit: readNumber(query.get('limit'), 30),
            offset: readOffset(query.get('offset')),
            // 实例会带上它，翻页时靠响应的 `more` 判断还有没有下一页。
            total: true,
        }),
    },
    '/artist/top/song': {
        mode: 'weapi',
        uri: '/api/artist/top/song',
        payload: query => ({ id: query.get('id') }),
    },
};

/**
 * 游客凭证重试的最小间隔。
 *
 * 注册失败时如果每个请求都再试一次，一次搜索会变成两个请求，而失败本身又最可能发生在被风控盯上的时候——
 * 正好是最不该加倍请求量的场合。参考实现把游客 token 缓存在进程里，这里用持久化的时间窗口达到同样效果，
 * 额外的好处是刷新页面、重开应用也不会重新锤一遍。
 */
const ANONYMOUS_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const ANONYMOUS_RETRY_KEY = 'anonymous_retry_at';

/**
 * 没有登录态也没有游客 token 时，先换一张游客凭证。
 *
 * 与参考实现一样是“尽力而为”：注册失败不阻断请求，网易大部分读接口匿名也能用，
 * 真正的拦路虎是播放地址，而那一步失败本来就有独立的降级提示。
 */
const ensureAnonymousSession = async (session: NeteaseSession): Promise<void> => {
    if (session.jar.MUSIC_U || session.jar.MUSIC_A) return;
    const lastAttempt = Number(readProviderSessionValue('netease', ANONYMOUS_RETRY_KEY) ?? 0);
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < ANONYMOUS_RETRY_INTERVAL_MS) return;
    writeProviderSessionValue('netease', ANONYMOUS_RETRY_KEY, String(Date.now()));

    const route = ROUTES['/register/anonimous'];
    try {
        const anonQuery = new URLSearchParams();
        const { data, cookies } = await callNeteaseEapi(session, resolveRouteUri(route, anonQuery), route.payload(anonQuery));
        session.jar = mergeSetCookies(session.jar, cookies);
        session.profile = resolveNeteaseDeviceProfile();
        if (Number(data?.code) !== 200) {
            console.warn('NetEase anonymous session rejected', data);
        }
    } catch (error) {
        console.warn('NetEase anonymous session unavailable', error);
    }
};

/**
 * `/playlist/track/all` 在实例里是两跳：先取歌单的 `trackIds`，再按 `limit/offset` 切一段去批量取详情。
 * 上游不允许一次把上千首塞进 song/detail，所以这个切分不能省。
 */
const requestPlaylistTracks = async (session: NeteaseSession, query: URLSearchParams): Promise<any> => {
    const detail = await callNeteaseEapi(session, '/api/v6/playlist/detail', {
        id: query.get('id'),
        n: 100000,
        s: readNumber(query.get('s'), 8),
    });
    session.jar = mergeSetCookies(session.jar, detail.cookies);

    const trackIds = Array.isArray(detail.data?.playlist?.trackIds) ? detail.data.playlist.trackIds : [];
    const limit = readNumber(query.get('limit'), 1000);
    const offset = readNumber(query.get('offset'), 0);
    const slice = trackIds.slice(offset, offset + limit);

    const songs = await callNeteaseEapi(session, '/api/v3/song/detail', {
        c: `[${slice.map((item: any) => `{"id":${Number(item?.id)}}`).join(',')}]`,
    });
    session.jar = mergeSetCookies(session.jar, songs.cookies);
    persistSession(session);

    return songs.data;
};

/** 本地生成二维码，不联网：上游实例这一步同样只是拼链接。 */
const createQrLoginResponse = (query: URLSearchParams) => {
    const key = query.get('key') ?? '';
    return {
        code: 200,
        data: {
            qrurl: buildNeteaseQrLoginUrl(key),
            qrimg: query.get('qrimg') ? renderNeteaseQrDataUrl(key) : '',
        },
    };
};

/**
 * `services/netease.ts` 的本地入口：接受与真实实例完全相同的路径 + query，返回同样的 JSON。
 *
 * 路由之外的路径返回实例同形的 404，让现有的“这条路由不支持”降级分支照旧生效。
 */
export const requestLocalNetease = async (endpoint: string): Promise<any> => {
    const [path, search = ''] = endpoint.split('?');
    const query = new URLSearchParams(search);

    if (path === '/login/qr/create') {
        return createQrLoginResponse(query);
    }

    if (path === '/playlist/track/all') {
        const session = loadSession();
        await ensureAnonymousSession(session);
        return requestPlaylistTracks(session, query);
    }

    const route = ROUTES[path];
    if (!route) {
        return { code: 404, msg: 'Not Found', data: null };
    }

    const session = loadSession();
    if (route.needsAnonymous !== false) {
        await ensureAnonymousSession(session);
    }

    const payload = route.payload(query);
    // 组 payload 可能刚换掉 deviceId（游客注册），请求头要用新的那一个。
    if (route.regeneratesDeviceId) {
        session.profile = resolveNeteaseDeviceProfile();
    }

    const call = route.mode === 'weapi' ? callNeteaseWeapi : callNeteaseEapi;
    const { data, cookies } = await call(session, resolveRouteUri(route, query), payload);

    session.jar = mergeSetCookies(session.jar, cookies);
    persistSession(session);

    return route.shape ? route.shape(data, serializeCookieJar(session.jar)) : data;
};
