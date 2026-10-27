// src/services/onlineMusic/qishui/qishuiNodeCrypto.ts
//
// 把 qishui-music-api 从 Node 搬到浏览器所需的两样东西：`Buffer` 和 `node:crypto`。
//
// 包里只用到一小撮东西：
//   protocol.cjs  generateKeyPairSync('ec', prime256v1) / createPrivateKey / sign('sha256', …) / randomBytes
//   catalog.cjs   randomUUID
//   auth.cjs      createHash('md5').update(…).digest('hex')
//  各文件        Buffer.from / Buffer.concat / toString('base64'|'utf8'|'hex')
//
// 真机装的是 WebView，没有 Node 的 crypto，所以这里用 @noble/curves 做 P-256：它同步、纯 JS、
// 体积小，正好满足「签名必须是同步调用」这个硬约束（WebCrypto 的 subtle 全是 Promise）。
// 导出的 PKCS#8 / SPKI / DER 签名格式与 Node 逐字节一致 —— 这一点用 openssl 和 Node 互相验过：
// 我们产出的 CSR 能被 openssl 认成合法的 PKCS#10 并通过自签校验，Node 也能验我们签的名。
//
// 这个模块同时负责把 `Buffer` 装到 globalThis 上：包里的代码是 `Buffer.from(...)` 这么写的，
// 而 ESM 的 import 顺序保证本模块先执行（qishuiLocalApi.ts 第一个 import 就是它）。
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { md5 } from '@noble/hashes/legacy';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const toBase64 = (bytes: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
            + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=')
            + (i + 2 < bytes.length ? B64[c & 63] : '=');
    }
    return out;
};

const fromBase64 = (text: string): Uint8Array => {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
            | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
        out[o] = (n >> 16) & 255;
        o += 1;
        if (o < out.length) { out[o] = (n >> 8) & 255; o += 1; }
        if (o < out.length) { out[o] = n & 255; o += 1; }
    }
    return out;
};

const fromHex = (text: string): Uint8Array => {
    const out = new Uint8Array(text.length >> 1);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
};

/** 够用的 Buffer 实例：只实现包里真正调到的那些实例方法。 */
export class QishuiBuffer extends Uint8Array {
    toString(encoding?: string): string {
        if (encoding === 'base64') return toBase64(this);
        if (encoding === 'hex') return Array.from(this).map((b) => b.toString(16).padStart(2, '0')).join('');
        return new TextDecoder().decode(this);
    }

    readUInt16BE(offset = 0): number {
        return ((this[offset] & 255) << 8) | (this[offset + 1] & 255);
    }

    readBigUInt64BE(offset = 0): bigint {
        let value = 0n;
        for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(this[offset + i] & 255);
        return value;
    }
}

const bufFrom = (input: string | ArrayLike<number> | ArrayBuffer, encoding?: string): QishuiBuffer => {
    if (typeof input === 'string') {
        if (encoding === 'hex') return new QishuiBuffer(fromHex(input));
        if (encoding === 'base64') return new QishuiBuffer(fromBase64(input));
        return new QishuiBuffer(new TextEncoder().encode(input));
    }
    if (input instanceof ArrayBuffer) return new QishuiBuffer(new Uint8Array(input));
    return new QishuiBuffer(Uint8Array.from(input));
};

const bufConcat = (list: ArrayLike<number>[]): QishuiBuffer => {
    const total = list.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const item of list) {
        out.set(item, offset);
        offset += item.length;
    }
    return new QishuiBuffer(out);
};

// 工厂挂在对象上、而不是写进类里：类里声明 `static from` 会和 `Uint8Array.from` 的
// 重载签名打架（TS2417），而那套签名我们并不需要。
const bufferApi = { from: bufFrom, concat: bufConcat };

type Installed = { Buffer?: unknown };
const scope = globalThis as unknown as Installed;
if (typeof scope.Buffer === 'undefined') {
    scope.Buffer = bufferApi;
}

// ---- P-256 / DER ----------------------------------------------------------------

const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_PRIME256V1 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

const tlv = (tag: number, ...values: QishuiBuffer[]): QishuiBuffer => {
    const value = bufConcat(values);
    const length = value.length < 128 ? bufFrom([value.length])
        : value.length < 256 ? bufFrom([0x81, value.length])
            : bufFrom([0x82, (value.length >> 8) & 255, value.length & 255]);
    return bufConcat([bufFrom([tag]), length, value]);
};

const pkcs8Der = (priv: Uint8Array, pub: Uint8Array): QishuiBuffer => {
    const ecPrivateKey = tlv(0x30,
        tlv(0x02, bufFrom([1])),
        tlv(0x04, new QishuiBuffer(priv)),
        tlv(0xa1, tlv(0x03, bufFrom([0]), new QishuiBuffer(pub))));
    return tlv(0x30,
        tlv(0x02, bufFrom([0])),
        tlv(0x30, tlv(0x06, bufFrom(OID_EC_PUBLIC_KEY)), tlv(0x06, bufFrom(OID_PRIME256V1))),
        tlv(0x04, ecPrivateKey));
};

const spkiDer = (pub: Uint8Array): QishuiBuffer => tlv(0x30,
    tlv(0x30, tlv(0x06, bufFrom(OID_EC_PUBLIC_KEY)), tlv(0x06, bufFrom(OID_PRIME256V1))),
    tlv(0x03, bufFrom([0]), new QishuiBuffer(pub)));

const pemOf = (der: QishuiBuffer, label: string): string => {
    const body = toBase64(der).match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

/** 只认自己写出的那种 PKCS#8：私钥是里面 ECPrivateKey 的 `02 01 01 04 20` + 32 字节。 */
const parsePkcs8Pem = (pem: string): { privateKey: Uint8Array; publicKey: Uint8Array } => {
    const der = fromBase64(pem.split('-----')[2]?.replace(/\s+/g, '') ?? '');
    for (let i = 0; i + 34 < der.length; i += 1) {
        if (der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x01
            && der[i + 3] === 0x04 && der[i + 4] === 0x20) {
            return { privateKey: der.slice(i + 5, i + 37), publicKey: der.slice(der.length - 65) };
        }
    }
    throw new Error('invalid guard key');
};

// ---- node:crypto 的替身 ----------------------------------------------------------

type GuardPrivateKey = {
    asymmetricKeyType: 'ec';
    asymmetricKeyDetails: { namedCurve: 'prime256v1' };
    /** 我们自己放的原始私钥，sign() 用。 */
    rawPrivateKey: Uint8Array;
    export: () => never;
};

const keyRefs = new WeakMap<object, Uint8Array>();

export const randomBytes = (size: number): QishuiBuffer => {
    const out = new Uint8Array(size);
    const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
    if (webCrypto?.getRandomValues) webCrypto.getRandomValues(out);
    else for (let i = 0; i < size; i += 1) out[i] = Math.floor(Math.random() * 256);
    return new QishuiBuffer(out);
};

export const randomUUID = (): string => {
    const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
    if (webCrypto?.randomUUID) return webCrypto.randomUUID();
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createHash = (algorithm: string) => {
    const chunks: Uint8Array[] = [];
    const api = {
        update(input: string | Uint8Array) {
            chunks.push(typeof input === 'string' ? new TextEncoder().encode(input) : input);
            return api;
        },
        digest(encoding?: string) {
            const joined = bufConcat(chunks);
            const digest = algorithm.toLowerCase() === 'md5'
                ? new QishuiBuffer(md5(joined))
                : new QishuiBuffer(sha256(joined));
            return encoding === 'hex' ? digest.toString('hex') : digest;
        },
    };
    return api;
};

export const generateKeyPairSync = (type: string, options?: { namedCurve?: string }) => {
    if (type !== 'ec' || (options?.namedCurve && options.namedCurve !== 'prime256v1')) {
        throw new Error('only prime256v1 is supported');
    }
    const priv = p256.utils.randomPrivateKey();
    const pub = p256.getPublicKey(priv, false);
    const privateKey = {
        asymmetricKeyType: 'ec' as const,
        asymmetricKeyDetails: { namedCurve: 'prime256v1' as const },
        rawPrivateKey: priv,
        export: (spec?: { type?: string; format?: string }) => {
            if (spec?.type !== 'pkcs8') throw new Error(`unsupported export ${spec?.type}`);
            const der = pkcs8Der(priv, pub);
            return spec?.format === 'pem' ? pemOf(der, 'PRIVATE KEY') : der;
        },
    };
    keyRefs.set(privateKey, priv);
    const publicKey = {
        export: (spec?: { type?: string; format?: string }) => {
            if (spec?.type !== 'spki') throw new Error(`unsupported export ${spec?.type}`);
            return spkiDer(pub);
        },
    };
    return { privateKey, publicKey };
};

export const createPrivateKey = (pem: string): GuardPrivateKey => {
    const parsed = parsePkcs8Pem(String(pem));
    const key: GuardPrivateKey = {
        asymmetricKeyType: 'ec',
        asymmetricKeyDetails: { namedCurve: 'prime256v1' },
        rawPrivateKey: parsed.privateKey,
        export: () => { throw new Error('export is not supported on a guard key'); },
    };
    keyRefs.set(key, parsed.privateKey);
    return key;
};

/** `sign('sha256', data, key)`：Node 默认返回 DER 编码的 ECDSA 签名，这里保持一致。 */
export const sign = (_algorithm: string, data: Uint8Array, key: GuardPrivateKey): QishuiBuffer => {
    const priv = keyRefs.get(key) ?? key.rawPrivateKey;
    if (!priv) throw new Error('invalid guard key');
    return new QishuiBuffer(p256.sign(sha256(data), priv).toBytes('der'));
};

/** 给 `import * as crypto` 那种写法用（包用的是解构 require，其实用不到，留着以防万一）。 */
export default { randomBytes, randomUUID, createHash, generateKeyPairSync, createPrivateKey, sign };
