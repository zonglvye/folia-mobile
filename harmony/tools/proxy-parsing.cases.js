// harmony/tools/proxy-parsing.cases.js
// HttpProxy.ets 里那几个纯函数的回归用例：路径匹配、query 百分号解码、Set-Cookie 拉平、
// URL 拆解、mime/charset 抽取、响应头大小写。
//
// 为什么需要它：这些是「不报错但会静默坏掉」的地方 —— 少解一次码，上游地址就拼不出来；
// 头名大小写写死，歌词和封面就全变成 octet-stream。而 ArkTS 在这里编译不了，
// 所以用 tsc 把它们当普通 TS 转出来，在 Node 里跑。
//
// 由 check-ets-helpers.ps1 调用，不要直接 node 它（它 require 转译产物）。
const assert = require('assert');

const cases = [];
const check = (name, fn) => {
    try {
        fn();
        cases.push(['ok  ', name]);
    } catch (error) {
        cases.push(['FAIL', name + ' -> ' + error.message]);
    }
};
const eq = (actual, expected) => assert.deepStrictEqual(actual, expected);

module.exports = (HttpProxy) => {
    check('owns() 认绝对 URL 上的代理路径', () => {
        eq(HttpProxy.owns('https://appassets.androidplatform.net/api/lyric-proxy?url=x'), true);
        eq(HttpProxy.owns('https://appassets.androidplatform.net/api/netease-proxy?url=x'), true);
    });

    check('owns() 不吃前缀相同的别的路径', () => {
        eq(HttpProxy.owns('https://appassets.androidplatform.net/api/lyric-proxyx'), false);
        eq(HttpProxy.owns('https://appassets.androidplatform.net/assets/index.js'), false);
    });

    check('query 参数要百分号解码', () => {
        const url = 'https://h/api/lyric-proxy?url=https%3A%2F%2Fu.y.qq.com%2Flyric%3Fa%3D1%26b%3D2';
        eq(HttpProxy.queryParam(url, 'url'), 'https://u.y.qq.com/lyric?a=1&b=2');
    });

    check('query 参数按 key 精确匹配，不被前缀同名干扰', () => {
        eq(HttpProxy.queryParam('https://h/p?myurl=bad&url=good', 'url'), 'good');
        eq(HttpProxy.queryParam('https://h/p?url=', 'url'), '');
        eq(HttpProxy.queryParam('https://h/p?other=1', 'url'), null);
    });

    check('query 里的 body/cookie 也要解码（网易表单）', () => {
        const url = 'https://h/api/netease-proxy?url=https%3A%2F%2Fmusic.163.com%2Fweapi%2Fx'
            + '&method=POST&body=params%3Dabc%26encSecKey%3Ddef&cookie=MUSIC_U%3D1%3B%20NMTID%3D2';
        eq(HttpProxy.queryParam(url, 'method'), 'POST');
        eq(HttpProxy.queryParam(url, 'body'), 'params=abc&encSecKey=def');
        eq(HttpProxy.queryParam(url, 'cookie'), 'MUSIC_U=1; NMTID=2');
    });

    check('Set-Cookie 拉平成 k=v，丢掉属性', () => {
        eq(
            HttpProxy.cookiesOf('MUSIC_U=abc123; Path=/; Domain=.music.163.com; HttpOnly'),
            'MUSIC_U=abc123',
        );
    });

    check('Set-Cookie 多条、含 Expires 里的逗号也要吃下', () => {
        eq(
            HttpProxy.cookiesOf('MUSIC_U=abc; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Secure, NMTID=xyz; Path=/'),
            'MUSIC_U=abc; NMTID=xyz',
        );
    });

    check('删除型 Set-Cookie 保留成 k=，否则登出删不掉', () => {
        eq(HttpProxy.cookiesOf('MUSIC_U=; Max-Age=0'), 'MUSIC_U=');
    });

    check('没有 Set-Cookie 时给空串', () => {
        eq(HttpProxy.cookiesOf(''), '');
    });

    check('parseUrl 拆出 scheme 与 host（含端口 / userinfo）', () => {
        eq(HttpProxy.parseUrl('https://interfacepc.music.163.com/eapi/x'), { scheme: 'https', host: 'interfacepc.music.163.com' });
        eq(HttpProxy.parseUrl('https://music.163.com:443/x'), { scheme: 'https', host: 'music.163.com' });
        eq(HttpProxy.parseUrl('https://user:pw@music.163.com/x'), { scheme: 'https', host: 'music.163.com' });
        eq(HttpProxy.parseUrl('ftp://music.163.com/x'), { scheme: 'ftp', host: 'music.163.com' });
        eq(HttpProxy.parseUrl('music.163.com/x'), null);
        eq(HttpProxy.parseUrl('https://'), null);
    });

    check('mime / charset 从 content-type 里拆出来', () => {
        eq(HttpProxy.mimeOf('image/jpeg; charset=binary'), 'image/jpeg');
        eq(HttpProxy.mimeOf(''), 'application/octet-stream');
        eq(HttpProxy.charsetOf('application/json; charset=UTF-8'), 'UTF-8');
        eq(HttpProxy.charsetOf('application/json; charset="utf-8"'), 'utf-8');
        eq(HttpProxy.charsetOf('image/png'), null);
    });

    check('headerOf 大小写不敏感地取响应头', () => {
        eq(HttpProxy.headerOf({ 'content-type': 'application/json' }, 'content-type'), 'application/json');
        eq(HttpProxy.headerOf({ 'Content-Type': 'application/json' }, 'content-type'), 'application/json');
        eq(HttpProxy.headerOf({ 'CONTENT-TYPE': 'application/json' }, 'content-type'), 'application/json');
        eq(HttpProxy.headerOf({}, 'content-type'), '');
    });

    check('reasonOf 给已知状态码配短语', () => {
        eq(HttpProxy.reasonOf(200), 'OK');
        eq(HttpProxy.reasonOf(403), 'Forbidden');
        eq(HttpProxy.reasonOf(418), 'Error');
    });

    const failed = cases.filter(([state]) => state === 'FAIL');
    for (const [state, name] of cases) {
        console.log(state + ' ' + name);
    }
    console.log('');
    console.log(`${cases.length - failed.length}/${cases.length} passed`);
    return failed.length === 0;
};
