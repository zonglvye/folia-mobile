import { renderSVG } from 'uqr';

// src/services/onlineMusic/neteaseQrImage.ts

/**
 * 扫码登录的二维码是本地画出来的，不需要联网。
 *
 * 参考实现的 `module/login_qr_create.js` 也只是把 key 拼成链接再交给 `qrcode` 生成图片：
 *   `https://music.163.com/login?codekey=${key}`
 * 真正联网的只有“要 key”和“轮询状态”两步（见 `neteaseLocalApi.ts`）。
 */
export const NETEASE_QR_LOGIN_URL_PREFIX = 'https://music.163.com/login?codekey=';

export const buildNeteaseQrLoginUrl = (key: string): string => `${NETEASE_QR_LOGIN_URL_PREFIX}${key}`;

/**
 * 把 unikey 画成 `<img src>` 能直接用的 data URL。
 *
 * 选 SVG 而不是 PNG：二维码是纯几何图形，SVG 在 152px 的展示尺寸上矢量清晰、体积只有几百字节，
 * 也不用为了导出 PNG 再拉一个 canvas 依赖。`ecc: 'M'` 与官方客户端一致，留一档纠错余量，
 * 手机在屏幕反光、倾斜角度下更好扫。border 必须留白，否则识别边界会贴着模块。
 */
export const renderNeteaseQrDataUrl = (key: string): string => {
    if (!key) return '';
    const svg = renderSVG(buildNeteaseQrLoginUrl(key), {
        ecc: 'M',
        border: 2,
        pixelSize: 4,
        whiteColor: '#FFFFFF',
        blackColor: '#000000',
    });
    // btoa 要求每字符 ≤ 0xFF；renderSVG 的输出是纯 ASCII，所以直接编码即可。
    try {
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    } catch {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
};
