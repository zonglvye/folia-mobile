import md5 from 'blueimp-md5';

// src/services/onlineMusic/neteaseCrypto.ts
// The two request encryption schemes NetEase's web/desktop clients use, implemented against the
// browser's own WebCrypto so the app can talk to the music platform without a relay server.
//
// This is a port of `util/crypto.js` from @neteasecloudmusicapienhanced/api, which is the reference
// the app was already speaking to. Constants are copied from there verbatim; the test file pins
// their output against vectors produced by that same reference implementation, so a drift in any of
// them fails a unit test rather than silently returning "invalid request" from the platform.
//
// Two things WebCrypto does not offer, handled explicitly below:
// - AES-ECB. eapi is ECB, so it is assembled out of single-block zero-IV CBC, which encrypts a block
//   to exactly E(block) (see `aesEcbEncrypt`).
// - Textbook RSA. `encSecKey` is the raw modular exponentiation of the reversed secret key with no
//   padding scheme at all, so it is done with BigInt instead of `crypto.subtle`'s RSA-OAEP.

const WEAPI_IV = '0102030405060708';
const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const WEAPI_SECRET_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const WEAPI_SECRET_LENGTH = 16;

/**
 * The 1024-bit modulus behind the public key in `util/crypto.js`, with its leading zero byte dropped
 * so it is exactly 128 bytes. The exponent is the usual 65537.
 */
const WEAPI_MODULUS_HEX = 'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const WEAPI_EXPONENT = 65537n;
const WEAPI_MODULUS_BYTES = 128;

const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_SEPARATOR = '-36cd479b6b5-';
const EAPI_SALT_PREFIX = 'nobody';
const EAPI_SALT_SUFFIX = 'use';
const EAPI_SALT_TAIL = 'md5forencrypt';

const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

const toHexUpper = (bytes: Uint8Array): string => (
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
);

const importAesKey = (key: string) => crypto.subtle.importKey('raw', encoder.encode(key), 'AES-CBC', false, ['encrypt']);

/** AES-128-CBC with PKCS#7 (WebCrypto's only CBC padding), matching CryptoJS's default. */
const aesCbcEncrypt = async (plaintext: string, key: string): Promise<Uint8Array> => {
    const cryptoKey = await importAesKey(key);
    const out = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: encoder.encode(WEAPI_IV) },
        cryptoKey,
        encoder.encode(plaintext),
    );
    return new Uint8Array(out);
};

/**
 * AES-128-ECB with PKCS#7, which WebCrypto has no mode for.
 *
 * A single 16-byte block run through CBC with a zero IV encrypts to exactly E(block), so encrypting
 * the padded plaintext one block at a time reproduces ECB. Each CBC call also appends a padding
 * block, which is dropped: the padding is applied once, here, before the loop.
 */
const aesEcbEncrypt = async (plaintext: string, key: string): Promise<Uint8Array> => {
    const cryptoKey = await importAesKey(key);
    const zeroIv = new Uint8Array(16);
    const raw = encoder.encode(plaintext);
    const padLength = 16 - (raw.length % 16);
    const padded = new Uint8Array(raw.length + padLength);
    padded.set(raw);
    padded.fill(padLength, raw.length);

    const out = new Uint8Array(padded.length);
    for (let offset = 0; offset < padded.length; offset += 16) {
        const block = padded.subarray(offset, offset + 16);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, cryptoKey, block));
        out.set(encrypted.subarray(0, 16), offset);
    }
    return out;
};

/** `base ** exponent mod modulus`, by square-and-multiply. */
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
 * Textbook RSA: the plaintext bytes as one big-endian integer, raised to the public exponent.
 * No padding is applied and none is expected — that is what `encSecKey` is, and it is why a padded
 * scheme like RSA-OAEP cannot be substituted here.
 */
const textbookRsaHex = (plaintext: Uint8Array): string => {
    let value = 0n;
    for (const byte of plaintext) value = (value << 8n) | BigInt(byte);
    const modulus = BigInt(`0x${WEAPI_MODULUS_HEX}`);
    return modPow(value, WEAPI_EXPONENT, modulus)
        .toString(16)
        .padStart(WEAPI_MODULUS_BYTES * 2, '0');
};

const createWeapiSecretKey = (): string => {
    let key = '';
    for (let index = 0; index < WEAPI_SECRET_LENGTH; index += 1) {
        key += WEAPI_SECRET_ALPHABET.charAt(Math.round(Math.random() * (WEAPI_SECRET_ALPHABET.length - 1)));
    }
    return key;
};

export interface WeapiEncrypted {
    params: string;
    encSecKey: string;
}

/**
 * The weapi envelope: the payload is AES-CBC'd twice (first with the fixed preset key, then with a
 * random per-request key), and that random key travels reversed and RSA-encrypted as `encSecKey`.
 *
 * `secretKey` exists so tests can pin the random half; production callers leave it out.
 */
export const weapiEncrypt = async (payload: unknown, secretKey?: string): Promise<WeapiEncrypted> => {
    const text = JSON.stringify(payload);
    const secret = secretKey ?? createWeapiSecretKey();
    // The second pass encrypts the base64 STRING the first pass produced, not its raw bytes.
    const once = toBase64(await aesCbcEncrypt(text, WEAPI_PRESET_KEY));
    const params = toBase64(await aesCbcEncrypt(once, secret));
    const reversed = secret.split('').reverse().join('');
    return { params, encSecKey: textbookRsaHex(encoder.encode(reversed)) };
};

/**
 * The eapi envelope: the payload is glued between its own URL and an MD5 of that whole string, and
 * the result is AES-ECB'd with a fixed key. `url` must be the full request path
 * (e.g. `/api/login/qrcode/unikey`) — it is part of the signed material, not just metadata.
 */
export const eapiEncrypt = async (url: string, payload: unknown): Promise<{ params: string }> => {
    const text = JSON.stringify(payload);
    const digest = md5(`${EAPI_SALT_PREFIX}${url}${EAPI_SALT_SUFFIX}${text}${EAPI_SALT_TAIL}`);
    const data = `${url}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;
    return { params: toHexUpper(await aesEcbEncrypt(data, EAPI_KEY)) };
};
