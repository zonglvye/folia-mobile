import { createHash, createDecipheriv } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    callNeteaseEapi,
    callNeteaseWeapi,
    type NeteaseSession,
} from '../../../src/services/onlineMusic/neteaseEapiTransport';

// test/unit/onlineMusic/neteaseEapiTransport.test.ts
//
// 这一层最容易“看着对、发出去全是 400”的地方是 eapi 的 payload 结构：设备头必须加密在密文里面，
// 而且密文里那段 MD5 摘要必须能对上同一份 JSON。所以断言不是比对十六进制常量（requestId 和
// buildver 每次不同，没法钉死），而是把密文解开、验证结构自洽：
//   1. 第一段是请求路径；2. 第二段是 JSON 且带完整设备头与 e_r:false；3. 第三段是那串 MD5。
// 任何一处漏掉，服务端都会以“参数错误”拒绝，而这里会在单测里先炸。

const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_SEPARATOR = '-36cd479b6b5-';
const DEVICE_ID = 'B'.repeat(52);
const NTES_NUID = 'a'.repeat(64);
const PROXY_ORIGIN = 'https://appassets.androidplatform.net';

const createSession = (): NeteaseSession => ({
    profile: {
        ntesNuid: NTES_NUID,
        ntesNnid: `${NTES_NUID},1700000000000`,
        wnmcid: 'abcdef.1700000000000.01.0',
        deviceId: DEVICE_ID,
    },
    jar: { MUSIC_U: 'session-token', __csrf: 'csrf-token' },
});

/** 解开一整段 AES-128-ECB 密文（大写十六进制）并去掉 PKCS#7 填充。只在测试里用得到。 */
const decryptEcb = (hex: string, key: string): string => {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
};

/** 拦下代理请求，返回拿到的 query 参数；响应体可指定，用来喂被测的整形逻辑。 */
const stubProxy = (envelopeBody = '{"code":200}') => {
    const calls: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (input: any) => {
        const url = new URL(String(input), PROXY_ORIGIN);
        calls.push(url.searchParams);
        return new Response(JSON.stringify({ status: 200, cookie: '', body: envelopeBody }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('callNeteaseEapi', () => {
    it('targets the eapi host with the path minus its /api prefix', async () => {
        const { calls } = stubProxy();
        await callNeteaseEapi(createSession(), '/api/cloudsearch/pc', { s: 'test' });

        expect(calls).toHaveLength(1);
        expect(calls[0].get('url')).toBe('https://interfacepc.music.163.com/eapi/cloudsearch/pc');
        expect(calls[0].get('method')).toBe('POST');
        expect(calls[0].get('ua')).toContain('NeteaseMusic');
    });

    it('encrypts the device header inside the payload and signs the exact JSON it sent', async () => {
        const { calls } = stubProxy();
        await callNeteaseEapi(createSession(), '/api/cloudsearch/pc', { s: 'test' });

        const params = new URLSearchParams(calls[0].get('body') ?? '').get('params') ?? '';
        const plaintext = decryptEcb(params, EAPI_KEY);
        const [uri, json, digest] = plaintext.split(EAPI_SEPARATOR);

        expect(uri).toBe('/api/cloudsearch/pc');
        expect(digest).toBe(createHash('md5').update(`nobody${uri}use${json}md5forencrypt`).digest('hex'));

        const payload = JSON.parse(json);
        expect(payload.s).toBe('test');
        expect(payload.e_r).toBe(false);
        expect(payload.header).toMatchObject({
            deviceId: DEVICE_ID,
            os: 'pc',
            versioncode: '140',
            resolution: '1920x1080',
            __csrf: 'csrf-token',
            MUSIC_U: 'session-token',
        });
        expect(payload.header.requestId).toMatch(/^\d{13}_\d{4}$/);
        expect(payload.header.NMTID).toMatch(/^00O[0-9a-f]{38}$/);
    });

    it('sends the same device header as the Cookie header', async () => {
        const { calls } = stubProxy();
        await callNeteaseEapi(createSession(), '/api/cloudsearch/pc', { s: 'test' });

        const cookie = calls[0].get('cookie') ?? '';
        expect(cookie).toContain(`deviceId=${DEVICE_ID}`);
        expect(cookie).toContain('__csrf=csrf-token');
        expect(cookie).toContain('MUSIC_U=session-token');
        // eapi 只发设备头，不发整份会话 cookie；后者是 weapi 的做法。
        expect(cookie).not.toContain('_ntes_nuid');
    });
});

describe('callNeteaseWeapi', () => {
    it('targets the weapi host and carries a Referer, which that endpoint requires', async () => {
        const { calls } = stubProxy();
        await callNeteaseWeapi(createSession(), '/api/v3/song/detail', { c: '[]' });

        expect(calls[0].get('url')).toBe('https://music.163.com/weapi/v3/song/detail');
        expect(calls[0].get('referer')).toBe('https://music.163.com');
        expect(calls[0].get('ua')).toContain('Chrome/124.0.0.0');
    });

    it('posts both encrypted halves, with encSecKey as 128 bytes of lowercase hex', async () => {
        const { calls } = stubProxy();
        await callNeteaseWeapi(createSession(), '/api/v3/song/detail', { c: '[]' });

        const body = new URLSearchParams(calls[0].get('body') ?? '');
        expect(body.get('params')).toBeTruthy();
        expect(body.get('encSecKey')).toMatch(/^[0-9a-f]{256}$/);
    });

    it('sends the whole cookie jar plus the device ring, unlike eapi', async () => {
        const { calls } = stubProxy();
        await callNeteaseWeapi(createSession(), '/api/v3/song/detail', { c: '[]' });

        const cookie = calls[0].get('cookie') ?? '';
        expect(cookie).toContain('MUSIC_U=session-token');
        expect(cookie).toContain(`_ntes_nuid=${NTES_NUID}`);
        expect(cookie).toContain('WNMCID=abcdef.1700000000000.01.0');
        expect(cookie).toContain('WEVNSM=1.0.0');
        expect(cookie).toContain('__remember_me=true');
    });
});

describe('failure handling', () => {
    it('tags a transport failure as a network failure, which playback classification reads', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));

        await expect(callNeteaseEapi(createSession(), '/api/cloudsearch/pc', {})).rejects.toMatchObject({
            networkFailure: true,
        });
    });

    it('reports the status when the shell answers with something that is not an envelope', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>nope</html>', { status: 502 })));

        await expect(callNeteaseEapi(createSession(), '/api/cloudsearch/pc', {})).rejects.toMatchObject({
            httpStatus: 502,
        });
    });

    it('passes an upstream error envelope through instead of throwing', async () => {
        stubProxy('{"code":502,"msg":"proxy request failed"}');

        const result = await callNeteaseEapi(createSession(), '/api/cloudsearch/pc', {});
        expect(result.status).toBe(200);
        expect(result.data).toEqual({ code: 502, msg: 'proxy request failed' });
    });
});
