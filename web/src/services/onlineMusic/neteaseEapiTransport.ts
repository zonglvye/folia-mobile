import { eapiEncrypt, weapiEncrypt } from './neteaseCrypto';
import { NETEASE_OS_PROFILE, type NeteaseDeviceProfile } from './neteaseDeviceProfile';

// src/services/onlineMusic/neteaseEapiTransport.ts

/**
 * eapi / weapi 请求的组装与投递。
 *
 * 这一层只做三件事：把请求头和 payload 拼成网易要的样子、加密、把结果经由壳里的
 * `/api/netease-proxy` 发出去。它不认识任何业务接口——路由表在 `neteaseLocalApi.ts`。
 *
 * 为什么必须走壳的代理：网易的接口域名不给 CORS 响应头，页面自己 fetch 会被浏览器拦掉；
 * 而 eapi/weapi 又都是 POST 带表单体，壳的拦截式代理拿不到页面请求的 body。
 * 于是壳只负责“原样重放一个 POST”，协议细节全在这里。
 */

export type NeteaseCookieJar = Record<string, string>;

export type NeteaseSession = {
    profile: NeteaseDeviceProfile;
    jar: NeteaseCookieJar;
};

export type NeteaseTransportResult = {
    /** 上游 HTTP 状态；调用方只在 ≥500 时当失败，与远端 API 实例的行为一致。 */
    status: number;
    data: any;
    /** 本次响应里的 Set-Cookie，已拉平成 `k=v; k=v`。 */
    cookies: string;
};

const PROXY_PATH = '/api/netease-proxy';
const EAPI_ORIGIN = 'https://interfacepc.music.163.com';
const WEAPI_ORIGIN = 'https://music.163.com';

/** 参考实现对 eapi 用的是 iPhone 档 UA，weapi 是桌面 Chrome 档，两者不能混用。 */
const EAPI_USER_AGENT = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const WEAPI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
/** api 档是桌面客户端，UA 与参考实现的 `userAgentMap.api.pc` 逐字一致。 */
const API_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117';

const VERSION_CODE = '140';
const RESOLUTION = '1920x1080';
const NMTID_ALPHABET = '0123456789abcdef';

/** `${毫秒}_${四位随机}`，参考实现用它给每个请求编号，服务端会读。 */
const createRequestId = (): string => (
    `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`
);

/** Cookie 头一律是 `encode(k)=encode(v)` 再用 `; ` 连接，key 和 value 都要编码。 */
const encodeCookieHeader = (record: NeteaseCookieJar): string => (
    Object.entries(record)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`)
        .join('; ')
);

const randomNmtid = (): string => {
    let tail = '';
    for (let index = 0; index < 38; index += 1) {
        tail += NMTID_ALPHABET[Math.floor(Math.random() * NMTID_ALPHABET.length)];
    }
    return `00O${tail}`;
};

/**
 * eapi 的请求头会被塞进**加密前的 payload**（`data.header`），同时也是 Cookie 头的内容。
 *
 * 这不是可选字段：服务端拿它当设备指纹的一部分，缺了版本号或分辨率会被当成异常客户端。
 * 取值顺序与参考实现的 `case 'eapi'` 分支保持一致，`NMTID` 优先用服务端下发过的那个。
 */
const buildEapiHeader = (session: NeteaseSession): NeteaseCookieJar => {
    const { profile, jar } = session;
    const header: NeteaseCookieJar = {
        osver: NETEASE_OS_PROFILE.osver,
        deviceId: profile.deviceId,
        os: NETEASE_OS_PROFILE.os,
        appver: NETEASE_OS_PROFILE.appver,
        versioncode: VERSION_CODE,
        mobilename: '',
        buildver: String(Date.now()).slice(0, 10),
        resolution: RESOLUTION,
        __csrf: jar.__csrf || '',
        channel: NETEASE_OS_PROFILE.channel,
        requestId: createRequestId(),
    };
    if (jar.MUSIC_U) header.MUSIC_U = jar.MUSIC_U;
    if (jar.MUSIC_A) header.MUSIC_A = jar.MUSIC_A;
    header.NMTID = jar.NMTID || randomNmtid();
    return header;
};

/** 把壳的 JSON 信封读成 `{status, data, cookies}`，并在这里把“壳自己出错”转成可识别的异常。 */
const readProxyEnvelope = async (response: Response, target: string): Promise<NeteaseTransportResult> => {
    const text = await response.text();
    let envelope: any;
    try {
        envelope = JSON.parse(text);
    } catch {
        // 壳返回的不是信封，说明请求根本没到达代理处理（路径没注册、或壳版本不支持）。
        throw Object.assign(
            new Error(`NetEase proxy returned HTTP ${response.status} without a JSON envelope: ${text.slice(0, 200)}`),
            { httpStatus: response.status },
        );
    }

    const status = Number(envelope?.status);
    const body = typeof envelope?.body === 'string' ? envelope.body : '';
    const cookies = typeof envelope?.cookie === 'string' ? envelope.cookie : '';

    let data: any;
    try {
        data = body ? JSON.parse(body) : {};
    } catch {
        throw Object.assign(
            new Error(`NetEase API ${target} returned HTTP ${Number.isFinite(status) ? status : '?'} without a JSON body: ${body.slice(0, 200) || '(empty)'}`),
            { httpStatus: Number.isFinite(status) ? status : 502 },
        );
    }

    return { status: Number.isFinite(status) ? status : 200, data, cookies };
};

/** 经由壳重放一个 POST；body 已经是要发出去的表单串。 */
const postThroughShell = async (
    target: string,
    body: string,
    cookieHeader: string,
    userAgent: string,
    referer?: string,
): Promise<NeteaseTransportResult> => {
    const query = new URLSearchParams({ url: target, method: 'POST', body, cookie: cookieHeader, ua: userAgent });
    if (referer) query.set('referer', referer);

    let response: Response;
    try {
        response = await fetch(`${PROXY_PATH}?${query.toString()}`, {
            // 会话 cookie 由 `neteaseLocalApi` 自己管，不借用浏览器那一份。
            credentials: 'omit',
            cache: 'no-store',
        });
    } catch (error) {
        throw Object.assign(
            new Error(`NetEase API request ${target} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
            { networkFailure: true },
        );
    }
    return readProxyEnvelope(response, target);
};

/** eapi：payload 里带设备头，Cookie 头就是那同一份设备头。 */
export const callNeteaseEapi = async (
    session: NeteaseSession,
    uri: string,
    payload: Record<string, unknown>,
): Promise<NeteaseTransportResult> => {
    const header = buildEapiHeader(session);
    const envelopePayload = { ...payload, e_r: false, header };
    const { params } = await eapiEncrypt(uri, envelopePayload);
    const body = new URLSearchParams({ params }).toString();
    const target = `${EAPI_ORIGIN}/eapi/${uri.replace(/^\/api\//, '')}`;
    return postThroughShell(target, body, encodeCookieHeader(header), EAPI_USER_AGENT);
};

/**
 * weapi 的 Cookie 头是“整份 cookie + 设备那圈字段”，与 eapi 只发设备头不同。
 *
 * 这里对应参考实现的 `processCookieObject`：会话里已有的值优先，缺的用本机设备身份补。
 * `MUSIC_A`（游客 token）不需要在这里追加——它由 `/register/anonimous` 的 Set-Cookie 进 jar，
 * 已经随 `...jar` 一起带上了。
 */
const buildProcessedCookie = (session: NeteaseSession): NeteaseCookieJar => {
    const { profile, jar } = session;
    return {
        ...jar,
        __remember_me: 'true',
        ntes_kaola_ad: '1',
        _ntes_nuid: jar._ntes_nuid || profile.ntesNuid,
        _ntes_nnid: jar._ntes_nnid || profile.ntesNnid,
        WNMCID: jar.WNMCID || profile.wnmcid,
        WEVNSM: jar.WEVNSM || '1.0.0',
        osver: jar.osver || NETEASE_OS_PROFILE.osver,
        deviceId: jar.deviceId || profile.deviceId,
        os: jar.os || NETEASE_OS_PROFILE.os,
        channel: jar.channel || NETEASE_OS_PROFILE.channel,
        appver: jar.appver || NETEASE_OS_PROFILE.appver,
        NMTID: jar.NMTID || randomNmtid(),
    };
};

/** weapi：payload 带 `csrf_token`，Cookie 头是整份会话 cookie，并且必须带 Referer。 */
export const callNeteaseWeapi = async (
    session: NeteaseSession,
    uri: string,
    payload: Record<string, unknown>,
): Promise<NeteaseTransportResult> => {
    const envelopePayload = { ...payload, csrf_token: session.jar.__csrf || '' };
    const { params, encSecKey } = await weapiEncrypt(envelopePayload);
    const body = new URLSearchParams({ params, encSecKey }).toString();
    const target = `${WEAPI_ORIGIN}/weapi/${uri.replace(/^\/api\//, '')}`;
    return postThroughShell(target, body, encodeCookieHeader(buildProcessedCookie(session)), WEAPI_USER_AGENT, WEAPI_ORIGIN);
};

/**
 * api：明文表单直发 `music.163.com/api/...`，身份只靠 Cookie，UA 是**桌面客户端**那一档。
 *
 * 参考实现把这一档设为默认（`request.js` 里 `crypto === '' → 'api'`），大量真实请求走的就是它。
 * 对扫码登录尤其重要：非浏览器的 HTTP 栈（壳里是系统网络栈）声称自己是 Chrome，会同时踩到
 * TLS/头部一致性检查；而声称自己是网易桌面客户端没有任何可被比对的地方，正是这一档的默认假设。
 */
export const callNeteaseApi = async (
    session: NeteaseSession,
    uri: string,
    payload: Record<string, unknown>,
): Promise<NeteaseTransportResult> => {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) {
            form.set(key, String(value));
        }
    }
    const target = `${WEAPI_ORIGIN}${uri}`;
    return postThroughShell(target, form.toString(), encodeCookieHeader(buildProcessedCookie(session)), API_USER_AGENT, WEAPI_ORIGIN);
};
