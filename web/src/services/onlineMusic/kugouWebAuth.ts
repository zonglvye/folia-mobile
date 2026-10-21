import md5 from 'blueimp-md5';
import type { ProviderUser } from '../../types/onlineMusic';
import {
    readProviderSessionValue,
    removeProviderSessionValue,
    writeProviderSessionValue,
} from './providerStorage';

// src/services/onlineMusic/kugouWebAuth.ts
//
// 酷狗的手机号验证码登录，直接跑在页面里，不需要 KuGouMusicApi 实例。
//
// 为什么在页面里做：`kugouProvider.auth` 原本每一条都对着 KuGouMusicApi 的路由，而那套路由在手机壳里
// 没有对应的服务，匿名模式下 provider 只能声明 auth:false。登录本身其实不依赖那台服务：发验证码与
// 验证码登录都是酷狗自己的 POST 接口，签名是固定盐的 md5，密码学部分只有 AES-256-CBC 与一把 1024 位
// 裸 RSA（右侧补零、无填充，和官方客户端一致）。
//
// 通道：页面把 target / 方法 / 请求体 / 少量白名单请求头塞进 `/api/lyric-proxy`，由壳用系统网络栈发出去。
// 壳只放行白名单域名与那几个头，因此这条代理不会变成开放中继。
//
// 身份：mid 必须是由 guid 算出的十进制大整数（md5(guid) 当十六进制数读），随手编一个 32 位 hex 会被
// 服务端当成参数错误——这一步是照着官方客户端对齐的，不是猜的。

/** 概念版（appid 3116）的客户端参数。和匿名检索用的是同一套身份。 */
const KUGOU_WEB_CLIENT = {
    appid: 3116,
    clientver: 11070,
    salt: 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA',
} as const;

/** 概念版 RSA 公钥的模数与指数（从官方客户端内置的 PEM 解出来的十六进制）。 */
const RSA_MODULUS = 'C40A2D0DA76511F3BB1CC2BBD3AFBD8BEA83B4D6B05B6C13EB8920C53F1AF7679B32BA0D0EDB843240EF1B836EFED3EE240734C14C1399FD6594D16AF22F52525D14D72E0155C6DCC8638D4F7BB94F3A0B1F4C29F991972F2A160A25EB0A9E724336BE7F69BBD319FFAB1C6DD8470B021DC434F3FABA89F4A2A01B33BDBDD08B';
const RSA_EXPONENT = '010001';

/** 验证码登录请求体里 t1/t2 用的固定 AES 密钥（官方客户端内置）。 */
const T1_KEY = '5e4ef500e9597fe004bd09a46d8add98';
const T1_IV = '04bd09a46d8add98';
const T2_KEY = 'fd14b35e3f81af3817a20ae7adae7020';
const T2_IV = '17a20ae7adae7020';

/** 登录请求的 UA：登录服务按客户端类型分辨行为。 */
const LOGIN_UA = 'Android16-1070-11440-130-0-LOGIN-wifi';

const GUID_KEY = 'web_guid';const DEV_KEY = 'web_dev';
const TOKEN_KEY = 'token';
const USERID_KEY = 'userid';
const DFID_KEY = 'dfid';
/** 登录成功的时间：用来区分「刚登录」与「登录了很久」的会话，见 kugouWebSessionAgeMs。 */
const LOGIN_AT_KEY = 'login_at';

/** 酷狗「未登录 / token 无效」的错误码。只有它代表登录态真的失效，别的错误码都算「这次没查成」。 */
const KUGOU_AUTH_ERROR_CODE = 20018;

const randomString = (length: number): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let index = 0; index < length; index += 1) {
        text += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return text;
};

const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * UTF-8 字节。返回值显式落在 ArrayBuffer 上：WebCrypto 的 BufferSource 不接受
 * SharedArrayBuffer 支撑的视图，而 TextEncoder 的返回类型在 TS 里是 ArrayBufferLike。
 */
const utf8 = (text: string): Uint8Array<ArrayBuffer> => {
    const encoded = new TextEncoder().encode(text);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    return copy;
};

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
};

/** 设备 guid：第一次用到时生成并记住，mid 由它算出来，换 guid 等于换设备。 */
const getGuid = (): string => {
    const stored = readProviderSessionValue('kugou', GUID_KEY);
    if (stored) return stored;
    const created = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${randomString(8)}-${randomString(4)}-${randomString(4)}-${randomString(4)}-${randomString(12)}`;
    writeProviderSessionValue('kugou', GUID_KEY, created);
    return created;
};

const getDev = (): string => {
    const stored = readProviderSessionValue('kugou', DEV_KEY);
    if (stored) return stored;
    const created = randomString(10).toUpperCase();
    writeProviderSessionValue('kugou', DEV_KEY, created);
    return created;
};

/** mid：md5(guid) 当成十六进制大整数读出来的十进制串。 */
export const getKugouWebMid = (): string => BigInt(`0x${md5(getGuid())}`).toString();

/** 每一次请求都会带上的公共参数（与官方客户端一致）。 */
const commonParams = (): Record<string, string | number> => ({
    dfid: readProviderSessionValue('kugou', DFID_KEY) || '-',
    mid: getKugouWebMid(),
    uuid: '-',
    appid: KUGOU_WEB_CLIENT.appid,
    clientver: KUGOU_WEB_CLIENT.clientver,
    clienttime: Math.floor(Date.now() / 1000),
});

/** Android 版签名：md5(盐 + 参数按 key 排序拼接 + 请求体 + 盐)。 */
const sign = (params: Record<string, string | number>, body = ''): string => {
    const sorted = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('');
    return md5(`${KUGOU_WEB_CLIENT.salt}${sorted}${body}${KUGOU_WEB_CLIENT.salt}`);
};

const query = (params: Record<string, string | number>): string => (
    Object.keys(params)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&')
);

/**
 * 登录链路的客户端头：与官方客户端一致（服务端按头识别客户端类型）。
 * 这些头不参与签名，但缺了会让登录服务把请求当成另一类客户端，所以照抄，不省略。
 */
const clientHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const params = commonParams();
    return {
        dfid: String(params.dfid),
        clienttime: String(params.clienttime),
        mid: String(params.mid),
        'kg-rc': '1',
        'kg-thash': '5d816a0',
        'kg-rec': '1',
        'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        ...extra,
    };
};

/** 一次代理请求；返回上游状态码与原始文本。 */
const proxyRequest = async (
    target: string,
    init: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> => {
    const parts = [`url=${encodeURIComponent(target)}`];
    if (init.method === 'POST') {
        parts.push('method=POST');
        if (init.body) parts.push(`body=${encodeURIComponent(init.body)}`);
        if (init.headers) parts.push(`headers=${encodeURIComponent(JSON.stringify(init.headers))}`);
    }
    const response = await fetch(`/api/lyric-proxy?${parts.join('&')}`);
    return { status: response.status, text: await response.text() };
};

const proxyJson = async (
    target: string,
    init: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> } = {},
): Promise<any> => {
    const answer = await proxyRequest(target, init);
    try {
        return JSON.parse(answer.text);
    } catch {
        throw new Error(`KuGou web login returned an unreadable body (HTTP ${answer.status})`);
    }
};

const aesKey = async (key: string): Promise<CryptoKey> => (
    crypto.subtle.importKey('raw', utf8(key), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
);

/** AES-256-CBC / PKCS7 加密，返回十六进制。WebCrypto 的 AES-CBC 自带 PKCS7 填充。 */
const aesEncryptHex = async (plain: string, key: string, iv: string): Promise<string> => {
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: utf8(iv) },
        await aesKey(key),
        utf8(plain),
    );
    return toHex(new Uint8Array(encrypted));
};

/** 与 aesEncryptHex 相对的解密；结果按 UTF-8 文本返回。 */
const aesDecryptHex = async (hex: string, key: string, iv: string): Promise<string> => {
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: utf8(iv) },
        await aesKey(key),
        fromHex(hex),
    );
    return new TextDecoder().decode(decrypted);
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
    let result = 1n;
    let factor = base % modulus;
    let power = exponent;
    while (power > 0n) {
        if (power & 1n) result = (result * factor) % modulus;
        factor = (factor * factor) % modulus;
        power >>= 1n;
    }
    return result;
};

/**
 * 裸 RSA（无填充）：把明文右侧补零到 128 字节，当成大整数做模幂。
 *
 * 补零方向是照官方客户端 `padded.set(buffer)` 抄的——习惯上的左补零会算出完全不同的密文，
 * 服务端只会回一句「参数错误」。
 */
const rsaEncrypt = (text: string): string => {
    const message = new Uint8Array(128);
    message.set(utf8(text));
    const encrypted = modPow(BigInt(`0x${toHex(message)}`), BigInt(`0x${RSA_EXPONENT}`), BigInt(`0x${RSA_MODULUS}`));
    return encrypted.toString(16).padStart(256, '0').toUpperCase();
};

const dataOf = (json: any): any => json?.data ?? json?.body?.data ?? json;

const errorTextOf = (json: any): string => {
    const data = json?.data;
    if (typeof data === 'string' && data.length > 0) return data;
    const field = json?.error ?? json?.error_msg ?? json?.msg;
    return typeof field === 'string' && field ? field : `error_code ${json?.error_code ?? '?'}`;
};

/** 手机号掩码（官方客户端只把掩码后的号码发给服务端做展示）。 */
const maskMobile = (mobile: string): string => (
    mobile.length >= 11 ? `${mobile.slice(0, 2)}*****${mobile.slice(10, 11)}` : mobile
);

/** 发验证码。成功时服务端回 status 1。 */
export const sendKugouLoginCode = async (mobile: string): Promise<void> => {
    const body = JSON.stringify({ businessid: 5, mobile, plat: 3 });
    const params = commonParams();
    const target = `http://login.user.kugou.com/v7/send_mobile_code?${query({ ...params, signature: sign(params, body) })}`;
    const json = await proxyJson(target, {
        method: 'POST',
        body,
        headers: clientHeaders({ 'Content-Type': 'application/json', 'User-Agent': LOGIN_UA }),
    });
    if (Number(json?.status) !== 1) {
        // 只把上游那句人话抛给界面（「手机格式不正确」「验证码过期」），技术前缀留在日志里。
        console.warn('[KugouAuth] send code rejected', errorTextOf(json));
        throw new Error(errorTextOf(json));
    }
};

export type KugouWebSession = { token: string; userid: string };

export const readKugouWebSession = (): KugouWebSession | null => {
    const token = readProviderSessionValue('kugou', TOKEN_KEY);
    const userid = readProviderSessionValue('kugou', USERID_KEY);
    return token && userid ? { token, userid } : null;
};

export const hasKugouWebSession = (): boolean => readKugouWebSession() !== null;

/** 这次登录存下来的时间戳；没有记录（旧版本存的会话）时返回 null。 */
export const kugouWebSessionAgeMs = (): number | null => {
    const stored = readProviderSessionValue('kugou', LOGIN_AT_KEY);
    const at = stored ? Number(stored) : NaN;
    return Number.isFinite(at) && at > 0 ? Date.now() - at : null;
};

/**
 * 手机号 + 验证码登录：成功后把 token/userid 写进 provider 存储，交给账户层像其它平台一样持久化。
 *
 * 应答里的 `secu_params` 是服务端用我们这次生成的 AES 密钥加密的凭据；解出来可能是 JSON，
 * 也可能直接就是 token 串，两种都要接。
 */
export const loginKugouWithCode = async (mobile: string, code: string): Promise<KugouWebSession> => {
    const dateTime = Date.now();
    const tempKey = randomString(16);
    const sessionKey = md5(tempKey);
    const sessionIv = sessionKey.slice(-16);
    const guid = getGuid();
    const dev = getDev();

    const paramsHex = await aesEncryptHex(JSON.stringify({ mobile, code }), sessionKey, sessionIv);
    const t2 = await aesEncryptHex(`${guid}|0f607264fc6318a92b9e13c65db7cd3c|02:00:00:00:00:00|${dev}|${dateTime}`, T2_KEY, T2_IV);
    const t1 = await aesEncryptHex(`|${dateTime}`, T1_KEY, T1_IV);
    const dfid = readProviderSessionValue('kugou', DFID_KEY) || randomString(24);

    const body = {
        plat: 1,
        support_multi: 1,
        t1,
        t2,
        clienttime_ms: dateTime,
        mobile: maskMobile(mobile),
        key: md5(`${KUGOU_WEB_CLIENT.appid}${KUGOU_WEB_CLIENT.salt}${KUGOU_WEB_CLIENT.clientver}${dateTime}`),
        pk: rsaEncrypt(JSON.stringify({ clienttime_ms: dateTime, key: tempKey })),
        params: paramsHex,
        dfid,
        dev,
        gitversion: '5f0b7c4',
    };
    const payload = JSON.stringify(body);
    const params = commonParams();
    const target = `https://loginserviceretry.kugou.com/v7/login_by_verifycode?${query({ ...params, signature: sign(params, payload) })}`;
    const json = await proxyJson(target, {
        method: 'POST',
        body: payload,
        headers: clientHeaders({ 'Content-Type': 'application/json', 'support-calm': '1', 'User-Agent': LOGIN_UA }),
    });
    if (Number(json?.status) !== 1) {
        console.warn('[KugouAuth] login rejected', errorTextOf(json));
        throw new Error(errorTextOf(json));
    }

    let session: KugouWebSession | null = null;
    let decryptedKeys: string[] = [];
    const secured = typeof json?.data?.secu_params === 'string' ? json.data.secu_params : '';
    if (secured) {
        const decrypted = await aesDecryptHex(secured, sessionKey, sessionIv);
        try {
            const parsed = JSON.parse(decrypted);
            decryptedKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
            if (parsed?.token) {
                // userid 以应答顶层为准：secu_params 里不一定带它，而顶层 data.userid 才是登录到的账号。
                session = { token: String(parsed.token), userid: String(json?.data?.userid ?? parsed?.userid ?? 0) };
            }
        } catch {
            session = { token: decrypted, userid: String(json?.data?.userid ?? 0) };
        }
    }
    if (!session && typeof json?.data?.token === 'string') {
        session = { token: json.data.token, userid: String(json.data.userid ?? 0) };
    }
    if (!session) throw new Error('KuGou login succeeded but returned no token');
    if (!session.userid || session.userid === '0') {
        // 没有 userid 时资料接口必然回 20018，存进去只会得到一个「登录成功但立刻掉线」的假象。
        throw new Error('登录成功但没有拿到用户 id');
    }

    writeProviderSessionValue('kugou', TOKEN_KEY, session.token);
    writeProviderSessionValue('kugou', USERID_KEY, session.userid);
    writeProviderSessionValue('kugou', DFID_KEY, dfid);
    writeProviderSessionValue('kugou', LOGIN_AT_KEY, String(Date.now()));
    // 只记结论，不记 token 本体（日志会进诊断报告）。ArkWeb 把对象打成 [object Object]，
    // 所以这里显式序列化成字符串，否则日志里看不到任何字段。
    console.info(`[KugouAuth] login ok ${JSON.stringify({
        userid: session.userid,
        hasToken: session.token.length > 0,
        dataKeys: Object.keys(json?.data ?? {}).slice(0, 12),
        decryptedKeys,
    })}`);
    return session;
};

/**
 * 账号资料应答的分类：只有 20018 是「没登录 / token 无效」，其它非零错误码是「这次没查成」。
 *
 * 单独拎出来是为了能直接测：把非零错误码一律当掉登录，会让一次限流或抖动把已保存的 token 删掉。
 */
export type KugouProfileOutcome =
    | { kind: 'ok'; data: any }
    | { kind: 'signed-out' }
    | { kind: 'error'; message: string };

export const classifyKugouProfileResponse = (json: any): KugouProfileOutcome => {
    const status = Number(json?.status);
    const errorCode = Number(json?.error_code ?? 0);
    if (status !== 0 && errorCode === 0) return { kind: 'ok', data: dataOf(json) ?? {} };
    if (errorCode === KUGOU_AUTH_ERROR_CODE) return { kind: 'signed-out' };
    const detail = typeof json?.data === 'string' ? ` ${json.data}` : '';
    return { kind: 'error', message: `KuGou profile request failed: error_code ${errorCode}${detail}` };
};

/** 读当前账号资料；没登录或凭据失效时返回 null。 */
export const fetchKugouWebUser = async (): Promise<ProviderUser | null> => {
    const session = readKugouWebSession();
    if (!session) return null;
    // 与官方客户端一致：打网关、用 x-router 头指到 usercenter；token/userid 同时进 query 参与签名。
    const clienttime = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
        visit_time: clienttime,
        usertype: 1,
        p: rsaEncrypt(JSON.stringify({ token: session.token, clienttime })),
        userid: Number(session.userid) || 0,
    });
    const params: Record<string, string | number> = {
        ...commonParams(),
        clienttime,
        token: session.token,
        userid: session.userid,
        plat: 1,
    };
    const target = `https://gateway.kugou.com/v3/get_my_info?${query({ ...params, signature: sign(params, payload) })}`;
    const json = await proxyJson(target, {
        method: 'POST',
        body: payload,
        headers: clientHeaders({
            'Content-Type': 'application/json',
            'x-router': 'usercenter.kugou.com',
            'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        }),
    });
    const outcome = classifyKugouProfileResponse(json);
    if (outcome.kind === 'signed-out') {
        console.warn(`[KugouAuth] profile signed-out ${JSON.stringify({ userid: session.userid })}`);
        return null;
    }
    if (outcome.kind === 'error') throw new Error(outcome.message);
    const data = outcome.data;
    const userid = String(data.userid ?? data.user_id ?? session.userid ?? '');
    if (!userid) return null;
    return {
        id: userid,
        nickname: String(data.nickname ?? data.nick_name ?? data.username ?? ''),
        avatarUrl: String(data.pic ?? data.avatar ?? data.user_pic ?? ''),
    };
};

/**
 * 账号接口的 UA：与官方客户端一致（登录服务与账号服务认不同的客户端类型）。
 */
const API_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

/** 账号会话；没有就抛错——账号接口不像资料那样「没有就返回 null」，调用方都是已登录路径。 */
const requireSession = (): KugouWebSession => {
    const session = readKugouWebSession();
    if (!session) throw new Error('KuGou account request needs a signed-in session');
    return session;
};

/**
 * 我的歌单（`/v7/get_all_list`，POST）。返回酷狗原始应答，归一化交给 provider。
 */
export const fetchKugouWebPlaylists = async (
    userid: string,
    page: number,
    pagesize: number,
): Promise<any> => {
    const session = requireSession();
    const accountId = Number(userid || session.userid) || 0;
    const body = JSON.stringify({
        userid: accountId,
        token: session.token,
        total_ver: 979,
        type: 2,
        page,
        pagesize,
    });
    const params: Record<string, string | number> = {
        ...commonParams(),
        userid: String(accountId),
        token: session.token,
        plat: 1,
    };
    const target = `https://gateway.kugou.com/v7/get_all_list?${query({ ...params, signature: sign(params, body) })}`;
    return proxyJson(target, {
        method: 'POST',
        body,
        headers: clientHeaders({
            'Content-Type': 'application/json',
            'x-router': 'cloudlist.service.kugou.com',
            'User-Agent': API_UA,
        }),
    });
};

/**
 * 歌单里的歌曲（`/pubsongs/v2/get_other_list_file_nofilt`，GET）。
 * 「我喜欢」也是一张歌单，所以红心列表走同一条。
 */
export const fetchKugouWebPlaylistTracks = async (
    globalCollectionId: string,
    page: number,
    pagesize: number,
): Promise<any> => {
    const params: Record<string, string | number> = {
        ...commonParams(),
        area_code: 1,
        begin_idx: Math.max(0, page - 1) * pagesize,
        plat: 1,
        type: 1,
        mode: 1,
        personal_switch: 1,
        extend_fields: 'abtags,hot_cmt,popularization',
        pagesize,
        global_collection_id: globalCollectionId,
    };
    const target = `https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?${query({ ...params, signature: sign(params) })}`;
    return proxyJson(target, { headers: clientHeaders({ 'User-Agent': API_UA }) });
};

/** 清掉本地登录态（服务端登出不重要：token 过期就自然失效）。 */
export const clearKugouWebSession = (): void => {
    [TOKEN_KEY, USERID_KEY, DFID_KEY, LOGIN_AT_KEY].forEach(key => removeProviderSessionValue('kugou', key));
};
