// src/services/shellOnlineAudio.ts
//
// 把在线音频的**远程地址**换成同源地址，再交给播放器。
//
// 为什么需要：鸿蒙壳里页面的 `<audio>` 带 `crossOrigin="anonymous"`（可视化/均衡器要 WebAudio
// 分析音频，必须要 CORS）。而网易对“网页客户端”下发的是带 `authSecret` / `cdntag=mark=os_web`
// 的签名地址，这类地址**任何 Origin 都不返回 Access-Control-Allow-Origin**，于是元素加载即失败、
// 表现为「有进度条但没有声音」。
//
// 两条通道，优先第一条：
//   1. 壳内存 + 页面取成 Blob（`mediaPrepare` / `mediaStatus` → `/api/media-proxy?token=…`）：
//      壳用系统网络栈把整首取成 ArrayBuffer，页面整首 fetch 回来再 `createObjectURL`。二进制不过
//      JS 字符串、没有 base64 解码开销。**不能把这个地址直接给 `<audio>`**：媒体元素会发非零起始的
//      Range，ArkWeb 的拦截器对那种 206 在真机上不生效（元素卡在已缓冲的 1MB 上）。
//   2. 回退：按 1 MiB 分块经 `/api/lyric-proxy` 取回、拼成 Blob。慢（一次 1.4MB base64 字符串×N），
//      只在壳不支持新桥方法时才会走到。
//
// 只在鸿蒙壳里生效：浏览器部署形态不需要它（那台机器上的音频地址本来就带 CORS）。

import { isShellNowPlayingSupported } from './shellNowPlaying';
import { retireBlobUrl } from './playbackBlobUrls';

/** 同源代理路径：与壳里 HttpProxy 的路线一致（回退通道用）。 */
const PROXY_PATH = '/api/lyric-proxy';
/** 壳内存直出的路径，与 Index.ets 的 MEDIA_PATH 一致。 */
const MEDIA_PATH = '/api/media-proxy';
/** 回退通道每块大小。 */
const CHUNK_BYTES = 1024 * 1024;
/** 单曲上限，防止一个坏地址把内存吃干。 */
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
/** 等壳把整首取进内存的上限（一首 320k mp3 约 8 MB）。 */
const BRIDGE_WAIT_MS = 30000;

/** 已转换过的地址（远程 URL → 壳 token）。重试/重播同一首不必再取一遍。 */
const tokenByRemoteUrl = new Map<string, number>();
/** blob 回退通道的缓存。 */
const blobUrlByRemoteUrl = new Map<string, string>();
const BLOB_URL_CACHE_LIMIT = 2;

type ShellMediaBridge = {
    mediaPrepare?: (url: string) => number;
    mediaStatus?: (token: number) => string;
};

const shellBridge = (): ShellMediaBridge | undefined => (
    typeof window === 'undefined' ? undefined : (window as { foliaAndroid?: ShellMediaBridge }).foliaAndroid
);

/** 这个地址要不要经过壳：远程 http(s) 才需要，blob:/data: 本来就没有跨域问题。 */
export const needsShellAudioRelay = (url: string | null | undefined): boolean => {
    if (!url) return false;
    if (!/^https?:/i.test(url)) return false;
    return isShellNowPlayingSupported();
};

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * 等壳把整首取进内存，返回 token；不可用（壳没有新桥方法 / 取失败 / 超时）返回 null。
 */
const prepareToken = async (url: string, bridge: ShellMediaBridge): Promise<number | null> => {
    const prepare = bridge.mediaPrepare;
    const status = bridge.mediaStatus;
    if (!prepare || !status) return null;

    let token = tokenByRemoteUrl.get(url);
    if (token === undefined) {
        const created = prepare.call(bridge, url);
        if (typeof created !== 'number' || created < 0) return null;
        token = created;
        tokenByRemoteUrl.set(url, token);
        if (tokenByRemoteUrl.size > 4) {
            // 壳内部只留最近两条，这里只管别让映射表无限长。
            const oldest = tokenByRemoteUrl.keys().next();
            if (!oldest.done) tokenByRemoteUrl.delete(oldest.value);
        }
    }

    const deadline = Date.now() + BRIDGE_WAIT_MS;
    while (Date.now() < deadline) {
        const state = status.call(bridge, token);
        if (state === 'ready') return token;
        if (state === 'failed' || state === 'missing') {
            tokenByRemoteUrl.delete(url);
            return null;
        }
        await sleep(60);
    }
    console.warn('[ShellAudio] shell media prepare timed out, falling back to the chunked proxy');
    return null;
};

/**
 * 把壳内存里的音频**在页面里取成 Blob**，而不是把 `/api/media-proxy` 地址直接交给 `<audio>`。
 *
 * 为什么不直接给元素：媒体元素会按 ~1MB 发 `Range: bytes=1048576-` 这类请求，而 ArkWeb 的
 * `onInterceptRequest` 对「非零起始的 206」在真机上不生效 —— 元素反复重发同一个 Range，播到
 * 已缓冲的 26 秒就 MEDIA_ERR_NETWORK。整首一次 GET 是好的（真机实测 14.8MB 正常取回），
 * 所以在这里整首取回、拼成 blob: 地址。blob 可 seek、离线可放，也不再经过媒体元素的 Range。
 */
const shellBlobSource = async (
    url: string,
    bridge: ShellMediaBridge,
): Promise<{ audioSrc: string; blobUrl: string } | null> => {
    const cached = blobUrlByRemoteUrl.get(url);
    if (cached) return { audioSrc: cached, blobUrl: cached };

    const token = await prepareToken(url, bridge);
    if (token === null) return null;

    const response = await fetch(`${MEDIA_PATH}?token=${token}`, { cache: 'no-store' });
    if (!response.ok) {
        console.warn(`[ShellAudio] media blob fetch failed: HTTP ${response.status}`);
        return null;
    }
    const raw = await response.blob();
    if (raw.size === 0) return null;
    const blob = /^audio\//i.test(raw.type) ? raw : new Blob([raw], { type: 'audio/mpeg' });
    const blobUrl = URL.createObjectURL(blob);
    rememberBlobUrl(url, blobUrl);
    retireBlobUrl(blobUrl);
    console.log(`[ShellAudio] relayed ${Math.round(blob.size / 1024)} KiB (blob path)`);
    return { audioSrc: blobUrl, blobUrl };
};

const rememberBlobUrl = (remoteUrl: string, blobUrl: string): void => {
    blobUrlByRemoteUrl.set(remoteUrl, blobUrl);
    if (blobUrlByRemoteUrl.size <= BLOB_URL_CACHE_LIMIT) return;
    const oldest = blobUrlByRemoteUrl.keys().next();
    if (!oldest.done) blobUrlByRemoteUrl.delete(oldest.value);
};

/** 回退通道取一块（range 由壳转成上游的 `Range` 头）；返回该块的字节。 */
const fetchChunk = async (remoteUrl: string, start: number, end: number): Promise<ArrayBuffer> => {
    const query = new URLSearchParams({ url: remoteUrl, range: `${start}-${end}` });
    const response = await fetch(`${PROXY_PATH}?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`audio proxy returned HTTP ${response.status}`);
    }
    return response.arrayBuffer();
};

/** 回退通道：分块取回 → Blob → blob: 地址。 */
const shellChunkedSource = async (url: string): Promise<{ audioSrc: string; blobUrl?: string }> => {
    const cached = blobUrlByRemoteUrl.get(url);
    if (cached) return { audioSrc: cached, blobUrl: cached };

    const chunks: BlobPart[] = [];
    let offset = 0;
    for (;;) {
        const buffer = await fetchChunk(url, offset, offset + CHUNK_BYTES - 1);
        const received = buffer.byteLength;
        if (received === 0) break;
        chunks.push(buffer);
        offset += received;
        if (offset > MAX_TOTAL_BYTES) throw new Error(`audio larger than ${MAX_TOTAL_BYTES} bytes`);
        // 上游忽略 Range、一次给回整首时也会走到这里：块不满就不再继续问。
        if (received < CHUNK_BYTES) break;
    }
    if (chunks.length === 0) throw new Error('audio proxy returned no bytes');

    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
    rememberBlobUrl(url, blobUrl);
    retireBlobUrl(blobUrl);
    console.log(`[ShellAudio] relayed ${Math.round(offset / 1024)} KiB (fallback path)`);
    return { audioSrc: blobUrl, blobUrl };
};

/**
 * 把远程音频地址变成同源地址。
 *
 * 失败时**回退到原地址**：让原有播放链路自己报错，比在这里伪装成功更好排查。
 */
export const materializeShellAudioSource = async (
    url: string,
): Promise<{ audioSrc: string; blobUrl?: string }> => {
    if (!needsShellAudioRelay(url)) {
        return { audioSrc: url };
    }

    const bridge = shellBridge();
    if (bridge) {
        try {
            const viaBlob = await shellBlobSource(url, bridge);
            if (viaBlob) {
                return { audioSrc: viaBlob.audioSrc, blobUrl: viaBlob.blobUrl };
            }
        } catch (error) {
            console.warn('[ShellAudio] blob path failed, trying the chunked proxy', error);
        }
    }

    try {
        return await shellChunkedSource(url);
    } catch (error) {
        console.warn('[ShellAudio] falling back to the remote audio URL', error);
        return { audioSrc: url };
    }
};
