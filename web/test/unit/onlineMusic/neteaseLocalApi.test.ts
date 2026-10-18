import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    parseCookieString,
    requestLocalNetease,
    serializeCookieJar,
} from '../../../src/services/onlineMusic/neteaseLocalApi';
import { isNeteaseRouteMissingResponse } from '../../../src/services/onlineMusic/neteasePlaybackFailure';

// test/unit/onlineMusic/neteaseLocalApi.test.ts
//
// 这个文件替代的是远端 API 实例，所以断言的基准是“实例会怎么回”，而不是“我们觉得该怎么回”：
// 每个 shape 的期望形态都对着 @neteasecloudmusicapienhanced/api 的模块源码和 netease.ts 的消费方式写的。
// 形态错了不会报错，只会安静地让扫码停在“等待扫码”，所以这些断言值得存在。

const PROXY_ORIGIN = 'https://appassets.androidplatform.net';

/** 没有登录态时，请求前会先换一张游客凭证；这个响应喂的就是那一步。 */
const ANONYMOUS_RESPONSE = '{"code":200,"userId":0}';

/** 拦下代理请求并按顺序返回给定响应体。 */
const stubProxy = (bodies: string[]) => {
    const calls: URLSearchParams[] = [];
    const queue = [...bodies];
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
        calls.push(new URL(String(input), PROXY_ORIGIN).searchParams);
        return new Response(JSON.stringify({ status: 200, cookie: '', body: queue.shift() ?? '{"code":200}' }), { status: 200 });
    }));
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('cookie jar', () => {
    it('reads both separator styles the API instance produces', () => {
        expect(parseCookieString('MUSIC_U=a; __csrf=b')).toEqual({ MUSIC_U: 'a', __csrf: 'b' });
        expect(parseCookieString('MUSIC_U=a;__csrf=b')).toEqual({ MUSIC_U: 'a', __csrf: 'b' });
    });

    it('keeps values that contain an equals sign', () => {
        expect(parseCookieString('MUSIC_A=abc==; x=1')).toEqual({ MUSIC_A: 'abc==', x: '1' });
    });

    it('ignores fragments without a name', () => {
        expect(parseCookieString('; =; lonely; ok=1')).toEqual({ ok: '1' });
    });

    it('never serialises an empty value, which is what a deletion looks like', () => {
        expect(serializeCookieJar({ MUSIC_U: 'a', MUSIC_A: '' })).toBe('MUSIC_U=a');
        expect(serializeCookieJar({})).toBe('');
    });
});

describe('local QR login', () => {
    it('draws the QR locally without touching the network', async () => {
        const calls = stubProxy([]);
        const response = await requestLocalNetease('/login/qr/create?key=ABC123&qrimg=true');

        expect(calls).toHaveLength(0);
        expect(response.code).toBe(200);
        expect(response.data.qrurl).toBe('https://music.163.com/login?codekey=ABC123');
        expect(response.data.qrimg.startsWith('data:image/svg+xml;base64,')).toBe(true);
        expect(Buffer.from(response.data.qrimg.split(',')[1], 'base64').toString('utf8')).toContain('<svg');
    });

    it('leaves the image empty when the caller did not ask for one', async () => {
        const response = await requestLocalNetease('/login/qr/create?key=ABC123');
        expect(response.data.qrimg).toBe('');
        expect(response.data.qrurl).toBe('https://music.163.com/login?codekey=ABC123');
    });

    it('wraps the unikey the way the instance does, so provider reads data.unikey', async () => {
        stubProxy(['{"code":200,"unikey":"KEY-1"}']);
        const response = await requestLocalNetease('/login/qr/key');

        expect(response).toEqual({ code: 200, data: { code: 200, unikey: 'KEY-1' } });
    });

    it('flattens the session cookie into the check response where the provider looks for it', async () => {
        stubProxy(['{"code":803,"message":"ok"}']);
        const response = await requestLocalNetease('/login/qr/check?key=KEY-1');

        expect(response.code).toBe(803);
        expect(typeof response.cookie).toBe('string');
    });
});

describe('route shapes the app consumes', () => {
    it('returns cloudsearch results untouched, because netease.ts merges privileges itself', async () => {
        const result = { code: 200, result: { songs: [{ id: 1 }], songCount: 1 } };
        // 第一个响应喂给请求前的游客注册，第二个才是 cloudsearch 本身。
        stubProxy([ANONYMOUS_RESPONSE, JSON.stringify(result)]);

        await expect(requestLocalNetease('/cloudsearch?keywords=a&limit=1&offset=0')).resolves.toEqual(result);
    });

    it('rewrites playback URLs to https, because the page origin is https', async () => {
        stubProxy([ANONYMOUS_RESPONSE, '{"code":200,"data":[{"id":1,"url":"http://m801.music.126.net/a.mp3"}]}']);

        const response = await requestLocalNetease('/song/url/v1?id=1&level=exhigh');
        expect(response.data[0].url).toBe('https://m801.music.126.net/a.mp3');
    });

    it('nests the account payload under data for login/status, which is where profile is read', async () => {
        stubProxy(['{"code":200,"profile":{"userId":7},"account":{"id":7}}']);

        const response = await requestLocalNetease('/login/status');
        expect(response.data.profile).toEqual({ userId: 7 });
    });
});

describe('artist page routes', () => {
    // 歌手页只打这三条；缺任何一条，从搜索点进去就是「暂无内容」——而网易是本机默认音源。
    // 参考实现：module/artist_detail.js、artist_album.js、artist_top_song.js。

    it('artist/album puts the artist id in the upstream path, not the payload', async () => {
        const calls = stubProxy([ANONYMOUS_RESPONSE, '{"code":200,"hotAlbums":[],"more":false}']);

        await requestLocalNetease('/artist/album?id=6452&limit=50&offset=100');

        const upstream = calls.map(call => call.get('url') ?? '');
        expect(upstream.some(url => url.includes('/artist/albums/6452'))).toBe(true);
        // 旧实现把它当未实现路由，上游一次都不会被请求。
        expect(upstream.some(url => url.includes('artist/album?'))).toBe(false);
    });

    it('artist/album passes hotAlbums and more through, which is how paging stops', async () => {
        const page = { code: 200, hotAlbums: [{ id: 1, name: 'A' }], more: true, artist: { id: 6452 } };
        stubProxy([ANONYMOUS_RESPONSE, JSON.stringify(page)]);

        await expect(requestLocalNetease('/artist/album?id=6452&limit=1&offset=0')).resolves.toEqual(page);
    });

    it('artist/detail reaches the head info endpoint that the instance maps it to', async () => {
        const detail = { code: 200, data: { artist: { id: 6452, name: '告五人' } } };
        const calls = stubProxy([ANONYMOUS_RESPONSE, JSON.stringify(detail)]);

        const response = await requestLocalNetease('/artist/detail?id=6452');

        expect(calls.some(call => (call.get('url') ?? '').includes('artist/head/info/get'))).toBe(true);
        expect(response.data.artist.name).toBe('告五人');
    });

    it('artist/top/song reaches the top song endpoint and keeps privileges in place', async () => {
        const top = { code: 200, songs: [{ id: 11 }], privileges: [{ id: 11, pl: 320000 }] };
        const calls = stubProxy([ANONYMOUS_RESPONSE, JSON.stringify(top)]);

        const response = await requestLocalNetease('/artist/top/song?id=6452');

        expect(calls.some(call => (call.get('url') ?? '').includes('artist/top/song'))).toBe(true);
        expect(response.privileges).toEqual([{ id: 11, pl: 320000 }]);
    });
});

describe('guest session bootstrap', () => {
    const createMemoryStorage = () => {
        const entries = new Map<string, string>();
        return {
            getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
            setItem: (key: string, value: string) => { entries.set(key, value); },
            removeItem: (key: string) => { entries.delete(key); },
        };
    };

    it('does not retry a rejected registration on every following request', async () => {
        // 失败时每次都重试，等于把一次搜索变成两个请求，而失败本身就说明可能已经被盯上了。
        vi.stubGlobal('localStorage', createMemoryStorage());
        const calls = stubProxy(['{"code":500}', '{"code":200,"result":{"songs":[]}}']);

        await requestLocalNetease('/cloudsearch?keywords=a');
        await requestLocalNetease('/cloudsearch?keywords=b');

        const registrations = calls.filter(call => (call.get('url') ?? '').includes('register/anonimous'));
        expect(registrations).toHaveLength(1);
    });
});

describe('unsupported routes', () => {
    it('answers with the instance shape that the missing-route classification already understands', async () => {
        const response = await requestLocalNetease('/album?id=1');

        expect(response).toEqual({ code: 404, msg: 'Not Found', data: null });
        expect(isNeteaseRouteMissingResponse(response)).toBe(true);
    });

    it('does not reach the network for a route it does not implement', async () => {
        const calls = stubProxy([]);
        await requestLocalNetease('/scrobble/v1?id=1&time=30');
        expect(calls).toHaveLength(0);
    });
});
