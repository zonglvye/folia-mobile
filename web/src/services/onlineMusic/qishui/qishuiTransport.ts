import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderErrorCode } from '../../../types/onlineMusic';
import type { QishuiOperation, QishuiParams } from 'qishui-music-api';
import { getQishuiAvailability as getLocalAvailability, requestQishuiBridge } from './qishuiLocalApi';

// src/services/onlineMusic/qishui/qishuiTransport.ts
//
// 上游这一层是「渲染进程 → 主进程 IPC」的边界：账号与播放器模型留在主进程，页面只拿结果。
// 手机壳里没有主进程可借，契约原样保留（同样的操作名、同样的错误码、同样的失败文案），
// 只把底层从 `window.electron.qishuiRequest` 换成本机实现：
// 包在页面里跑（node:crypto 由 qishuiNodeCrypto 顶替），HTTP 走壳的同源代理。
export type { QishuiOperation, QishuiParams, QishuiBridgeResult } from 'qishui-music-api';

// 与上游同名同义：这个页面没有可用的汽水通道（例如浏览器里没有壳代理）。
export const QISHUI_NEEDS_DESKTOP = 'Qishui requires the desktop app';
export const QISHUI_BRIDGE_FAILED = 'Qishui desktop request failed';
const STAGES = ['access-code', 'ticket', 'account'] as const;
export type QishuiLoginStage = typeof STAGES[number];
// 最近一次登录类操作（login_*）的失败，给登录诊断用；登录途中顺带发的歌词、电台、封面请求不算。
let lastFailure: { stage: QishuiLoginStage | null; code: ProviderErrorCode; upstreamCode?: string } | null = null;
export const getQishuiLastFailure = () => lastFailure;
const isLoginOperation = (operation: QishuiOperation) => operation.startsWith('login_');
export class QishuiRequestError extends OnlineProviderError {
    constructor(code: ProviderErrorCode, message: string, public readonly stage: QishuiLoginStage | null, public readonly upstreamCode?: string) {
        super(code, message, 'qishui');
    }
}
export const getQishuiAvailability = () => (
    getLocalAvailability().configured
        ? { configured: true } as const : { configured: false, reason: 'runtime-unavailable' } as const
);
export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (operation === 'login_qr_key') lastFailure = null;
    if (!getQishuiAvailability().configured) throw new OnlineProviderError('unavailable', QISHUI_NEEDS_DESKTOP, 'qishui');
    let result;
    try { result = await requestQishuiBridge(operation, params); }
    catch (error) { throw new OnlineProviderError('network', QISHUI_BRIDGE_FAILED, 'qishui', error); }
    if (!result.ok) {
        const stage = STAGES.find(stage => stage === result.error.stage) ?? null;
        const upstreamCode = typeof result.error.upstreamCode === 'string' && /^\d{1,12}$/.test(result.error.upstreamCode) ? result.error.upstreamCode : undefined;
        if (isLoginOperation(operation)) lastFailure = { stage, code: result.error.code, upstreamCode };
        throw new QishuiRequestError(result.error.code, result.error.message, stage, upstreamCode);
    }
    return result.data as T;
}

// The image type the bytes themselves say, for the formats a scene icon comes in; null when they say none of them.
function sniffImageType(bytes: Uint8Array): string | null {
    const starts = (...head: number[]) => head.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
}
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

// Scene artwork is public CDN content; it is fetched without any account headers or cookies.
// The data URL carries the image's own type: the CDN's template decides the format, not the address.
//
// 手机壳里**不能**直接 fetch：douyinpic.com 不带 CORS 头，页面直连会被拦。改走同源代理
// （壳已把 douyinpic.com 放进白名单），回来的仍是原始字节与原始 content-type。
export async function readQishuiSceneIcon(raw: string): Promise<string> {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !/(?:^|\.)douyinpic\.com$/.test(url.hostname) || url.username || url.password) {
        throw new Error('Invalid scene artwork URL');
    }
    const response = await fetch(`/api/lyric-proxy?url=${encodeURIComponent(url.href)}`);
    const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !declared.startsWith('image/')) throw new Error('Scene artwork is unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 512 * 1024) throw new Error('Scene artwork is too large');
    const type = sniffImageType(bytes) ?? (RASTER_TYPES.has(declared) ? declared : null);
    if (!type) throw new Error('Scene artwork is not a raster image');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${type};base64,${btoa(binary)}`;
}
