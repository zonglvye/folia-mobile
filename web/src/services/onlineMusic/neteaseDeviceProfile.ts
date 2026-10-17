import { readProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/neteaseDeviceProfile.ts

/**
 * 网易 eapi/weapi 接口期望看到的“稳定设备身份”。
 *
 * 这几项不是可选的装饰：真实客户端每次请求都会把 `_ntes_nuid`、`_ntes_nnid`、`WNMCID`、
 * `deviceId` 一起带上去，服务端据此把同一台设备上的请求串成一条连续的行为，突发变化会被当成异常流量。
 * 所以它们必须落到 localStorage 里、跨会话保持不变，而不是每次请求随机生成。
 *
 * 取值规则逐字对齐参考实现（`util/request.js` 的 `processCookieObject` 与
 * `module/register_anonimous.js` 的 `generateDeviceId`），长度和字母表都不能改：
 *   - `_ntes_nuid`  32 字节随机数的十六进制串（64 位小写）
 *   - `_ntes_nnid`  `${_ntes_nuid},${首次生成毫秒时间戳}`
 *   - `WNMCID`      6 位小写字母 + `.${毫秒时间戳}.01.0`
 *   - `deviceId`    52 位大写十六进制
 */
export type NeteaseDeviceProfile = {
    ntesNuid: string;
    ntesNnid: string;
    wnmcid: string;
    deviceId: string;
};

/**
 * 请求头/ Cookie 里那圈系统信息。
 *
 * 刻意照抄参考实现的默认值（桌面 pc 那一档），而不是伪装成 Android：这条路径是被大量真实请求验证过的，
 * 自己换一套档位等于引入一个没人验证过的组合。用户代理同理走 iPhone 那一档，见 `neteaseLocalApi`。
 */
export const NETEASE_OS_PROFILE = {
    os: 'pc',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    appver: '3.1.17.204416',
    channel: 'netease',
} as const;

const PROFILE_KEY = 'device_profile';
const LOWER_HEX = '0123456789abcdef';
const UPPER_HEX = '0123456789ABCDEF';
const LOWER_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** 用平台随机源取随机字符；`getRandomValues` 不可用时退回 Math.random（只影响辨识度，不影响正确性）。 */
const pickRandom = (alphabet: string, count: number): string => {
    const bytes = new Uint8Array(count);
    const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
        webCrypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < count; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    let out = '';
    for (let index = 0; index < count; index += 1) {
        out += alphabet[bytes[index] % alphabet.length];
    }
    return out;
};

/** 52 位大写十六进制，长度与参考实现的 `generateDeviceId` 一致。 */
export const createNeteaseDeviceId = (): string => pickRandom(UPPER_HEX, 52);

/** 生成一份全新的设备身份（只在第一次运行、或存储被清空时调用）。 */
export const createNeteaseDeviceProfile = (): NeteaseDeviceProfile => {
    const ntesNuid = pickRandom(LOWER_HEX, 64);
    return {
        ntesNuid,
        ntesNnid: `${ntesNuid},${Date.now()}`,
        wnmcid: `${pickRandom(LOWER_LETTERS, 6)}.${Date.now()}.01.0`,
        deviceId: createNeteaseDeviceId(),
    };
};

const isUsableProfile = (value: unknown): value is NeteaseDeviceProfile => {
    const candidate = value as Partial<NeteaseDeviceProfile> | null;
    return Boolean(
        candidate
        && typeof candidate.ntesNuid === 'string' && candidate.ntesNuid.length === 64
        && typeof candidate.ntesNnid === 'string' && candidate.ntesNnid.includes(',')
        && typeof candidate.wnmcid === 'string' && candidate.wnmcid.length > 0
        && typeof candidate.deviceId === 'string' && candidate.deviceId.length === 52,
    );
};

/**
 * 进程内缓存：设备身份是跨会话不变的常量，而它每个请求都要用一次。
 * 不缓存就要每次读两条 localStorage 再 JSON.parse 一遍。
 */
let cachedProfile: NeteaseDeviceProfile | null = null;

const persist = (profile: NeteaseDeviceProfile): NeteaseDeviceProfile => {
    writeProviderSessionValue('netease', PROFILE_KEY, JSON.stringify(profile));
    cachedProfile = profile;
    return profile;
};

/** 读取设备身份；缺失或损坏时新建并把新值写回去。 */
export const resolveNeteaseDeviceProfile = (): NeteaseDeviceProfile => {
    if (cachedProfile) return cachedProfile;
    const stored = readProviderSessionValue('netease', PROFILE_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (isUsableProfile(parsed)) {
                cachedProfile = parsed;
                return parsed;
            }
        } catch {
            // 存储损坏就重建：继续用一份半截身份会让每个请求都带着错位的字段。
        }
    }
    return persist(createNeteaseDeviceProfile());
};

/**
 * 记下游客注册时拿到的 `deviceId`。
 *
 * `/register/anonimous` 每次都会现生成一个 deviceId 并返回同一份身份给后续请求用，
 * 所以拿到之后必须覆盖存储里的旧值，否则后续请求的 `deviceId` 头和 Cookie 会对不上。
 */
export const adoptNeteaseDeviceId = (deviceId: string): void => {
    if (!deviceId) return;
    persist({ ...resolveNeteaseDeviceProfile(), deviceId });
};
