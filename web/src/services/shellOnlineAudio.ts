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
// 只在打包壳里生效：浏览器部署形态不需要它（那台机器上的音频地址本来就带 CORS）。
// 两个壳（鸿蒙 / 安卓）实现的是同一组桥方法，页面这边只有一份实现。

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
    mediaProgress?: (token: number) => number;
};

const shellBridge = (): ShellMediaBridge | undefined => (
    typeof window === 'undefined' ? undefined : (window as { foliaAndroid?: ShellMediaBridge }).foliaAndroid
);

/** 这个壳有没有「把音频取进内存再同源交出」的能力（鸿蒙壳与安卓壳是同一组桥方法）。 */
const hasShellMediaCache = (): boolean => {
    const bridge = shellBridge();
    return typeof bridge?.mediaPrepare === 'function' && typeof bridge?.mediaStatus === 'function';
};

/**
 * 这些主机的音频对 `<audio>` 是**可以直接播**的：字节系 CDN（汽水音乐的音源、封面）。
 * 判据来自真机实测：ArkWeb 的媒体栈能自己发 Range 请求、自己解 AAC/MP4，
 * 所以不需要壳把这几个 MB 取进内存再分块交回来。
 */
const DIRECT_PLAYABLE_HOSTS = /(?:^|\.)(?:365yg\.com|douyinvod\.com|douyinscdn\.com|bytefcdn\.com|bytecdn\.cn|byteicdn\.com|ibytedtos\.com|pstatp\.com|snssdk\.com|bytedance\.com|bytetos\.com|volcvideo\.com|volccdn\.com|volces\.com|volcengineapi\.com|douyin\.com|qishui\.com|zijieapi\.com|zjcdn\.com)$/;

const isDirectPlayableCdn = (url: string): boolean => {
    try {
        return DIRECT_PLAYABLE_HOSTS.test(new URL(url).hostname);
    } catch {
        return false;
    }
};

/** 这个地址要不要经过壳：远程 http(s) 才需要，blob:/data: 本来就没有跨域问题。 */
export const needsShellAudioRelay = (url: string | null | undefined): boolean => {
    if (!url) return false;
    if (!/^https?:/i.test(url)) return false;
    // 汽水（qishui）的音源走字节的 CDN：真机实测 <audio> 能直接播（Range 也支持），
    // 而它一首只有 1–2 MB 的 AAC，中继一遍（取进壳内存再分块交回页面）纯属多绕一圈。
    // 直连还能让播放器自己按需取，省掉我们那套 MSE 分块的复杂度。
    if (isDirectPlayableCdn(url)) return false;
    // 判据是「壳能不能中转」，不是「壳是不是鸿蒙」：锁屏那套（isShellNowPlayingSupported）只有
    // 鸿蒙壳开通了，但两个壳的媒体缓存是一样的，而签名音频地址对谁都不发 CORS 头。
    // 桌面与 PWA 形态没有 foliaAndroid，于是照旧把远程地址直接交给 <audio>。
    return hasShellMediaCache();
};

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** 流式播放的块大小：一次取这么多字节丢给 MediaSource。 */
const MSE_CHUNK_BYTES = 256 * 1024;
/** 够不够开始放：第一块到齐就起播，不等整首。 */
const MSE_START_BYTES = 64 * 1024;
/** MediaSource 只支持 audio/mpeg（真机实测：mp4/flac/webm 都是 false）。 */
const MSE_TYPE = 'audio/mpeg';

/** 拿到 token（不等待下载完成）。 */
const startToken = (url: string, bridge: ShellMediaBridge): number | null => {
    const prepare = bridge.mediaPrepare;
    if (!prepare) return null;

    const existing = tokenByRemoteUrl.get(url);
    if (existing !== undefined) return existing;

    const created = prepare.call(bridge, url);
    if (typeof created !== 'number' || created < 0) return null;
    tokenByRemoteUrl.set(url, created);
    if (tokenByRemoteUrl.size > 4) {
        const oldest = tokenByRemoteUrl.keys().next();
        if (!oldest.done) tokenByRemoteUrl.delete(oldest.value);
    }
    return created;
};

/** 取壳里 `[start, end]` 这一段。
 *
 * 不用 Range 头：真机上拦截器确实回了 206 + 262144 字节，页面这边 `fetch` 却拿到失败
 * （ArkWeb 对拦截器 206 的处理不可靠）。改成查询参数，壳回一个干净的 200。 */
const fetchShellRange = async (token: number, start: number, end: number): Promise<ArrayBuffer | null> => {
    const response = await fetch(`${MEDIA_PATH}?token=${token}&from=${start}&to=${end}`, {
        cache: 'no-store',
    });
    if (!response.ok) {
        console.warn(`[ShellAudio] slice ${start}-${end} -> HTTP ${response.status}`);
        return null;
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
        console.warn(`[ShellAudio] slice ${start}-${end} -> empty body (HTTP ${response.status})`);
        return null;
    }
    return buffer;
};

/** 是不是 mp3 码流（ID3 头或帧同步字）。不是就走 blob 老路。 */
const looksLikeMp3 = (buffer: ArrayBuffer): boolean => {
    if (buffer.byteLength < 3) return false;
    const bytes = new Uint8Array(buffer, 0, 3);
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
};

/**
 * 流式播放：边下边放。
 *
 * 以前要等整首 8–10 MB 下完（约 4 秒）才能出声；现在壳一下载，页面就把已到达的部分按 Range
 * 取进 MediaSource，64 KB 就能起播。第一块不是 mp3（比如无损首发的 flac）直接返回 null，
 * 交给原来的 blob 路径——MSE 在 ArkWeb 上只认 audio/mpeg。
 */
const streamViaMse = async (
    url: string,
    bridge: ShellMediaBridge,
    knownDurationSec?: number,
): Promise<{ audioSrc: string; blobUrl?: string } | null> => {
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(MSE_TYPE)) return null;
    const progress = bridge.mediaProgress;
    const status = bridge.mediaStatus;
    if (!progress || !status) return null;

    const token = startToken(url, bridge);
    if (token === null) return null;

    const waitingSince = Date.now();
    let available = 0;
    while (Date.now() - waitingSince < 8000) {
        available = progress.call(bridge, token);
        const state = status.call(bridge, token);
        if (state === 'failed' || state === 'missing') {
            tokenByRemoteUrl.delete(url);
            return null;
        }
        if (available >= MSE_START_BYTES || (state === 'ready' && available > 0)) break;
        await sleep(40);
    }
    if (available === 0) return null;

    const head = await fetchShellRange(token, 0, Math.min(available, MSE_CHUNK_BYTES) - 1);
    if (!head) {
        console.warn('[ShellAudio] mse: head fetch failed');
        return null;
    }
    const magic = Array.from(new Uint8Array(head, 0, Math.min(4, head.byteLength)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
    if (!looksLikeMp3(head)) {
        console.warn(`[ShellAudio] mse: not mp3 (first bytes ${magic}), falling back`);
        return null;
    }
    console.log(`[ShellAudio] mse: head ${head.byteLength} bytes, magic ${magic}`);

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);

    // MediaSource 只有在被挂到 `<audio src>` 之后才会 open，而挂 src 的是调用方（播放器）。
    // 所以这里先把地址交出去，起播准备放到后台等 open。
    void (async () => {
        try {
            const openedAt = Date.now();
            while (mediaSource.readyState !== 'open') {
                if (Date.now() - openedAt > 8000) throw new Error('sourceopen timeout');
                await sleep(20);
            }
            const sourceBuffer = mediaSource.addSourceBuffer(MSE_TYPE);
            sourceBuffer.mode = 'sequence';
            // 流的真实长度要等 endOfStream 之后浏览器才算得出来，而按「领先 30 秒」的节流方式
            // 那要等到整首播完——中间这段时间 duration 会是 Infinity：进度条没有总长、锁屏页拿不到
            // positionState。曲目本身知道长度，直接告诉 MediaSource，元素随即报出有限值。
            if (typeof knownDurationSec === 'number' && Number.isFinite(knownDurationSec) && knownDurationSec > 0) {
                try {
                    mediaSource.duration = knownDurationSec;
                } catch {
                    // 早期设置失败不影响后续追加，退回到「浏览器自己算」。
                }
            }

            const append = (chunk: ArrayBuffer) => new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    sourceBuffer.removeEventListener('updateend', onEnd);
                    sourceBuffer.removeEventListener('error', onError);
                };
                const onEnd = () => {
                    cleanup();
                    resolve();
                };
                const onError = () => {
                    cleanup();
                    reject(new Error('sourcebuffer error'));
                };
                sourceBuffer.addEventListener('updateend', onEnd);
                sourceBuffer.addEventListener('error', onError);
                try {
                    sourceBuffer.appendBuffer(chunk);
                } catch (error) {
                    // appendBuffer 在额度用尽时**同步**抛 QuotaExceededError，上面的 error 事件不会来。
                    cleanup();
                    reject(error);
                }
            });

            // 丢掉最前面一段已缓冲的数据，换成额度继续往里塞。
            const evictOldest = (ratio: number) => new Promise<void>((resolve, reject) => {
                const buffered = sourceBuffer.buffered;
                if (!buffered.length) { resolve(); return; }
                const start = buffered.start(0);
                const end = buffered.end(buffered.length - 1);
                const cut = start + (end - start) * ratio;
                if (!(cut > start)) { resolve(); return; }
                const cleanup = () => {
                    sourceBuffer.removeEventListener('updateend', onEnd);
                    sourceBuffer.removeEventListener('error', onError);
                };
                const onEnd = () => {
                    cleanup();
                    resolve();
                };
                const onError = () => {
                    cleanup();
                    reject(new Error('sourcebuffer remove error'));
                };
                sourceBuffer.addEventListener('updateend', onEnd);
                sourceBuffer.addEventListener('error', onError);
                sourceBuffer.remove(start, cut);
            });

            // 真机上这道额度是真的会撞上：整首 10 MB 全部追加完之前就会抛 QuotaExceededError，
            // 一旦抛出去后面的数据再也不会进缓冲（表现为时长 Infinity、进度条不动、播到缓冲末尾就断）。
            // 两手：正常情况按「播放头前面只留 AHEAD_SECONDS 秒」放行，压根不把额度填满；
            // 万一还是撞上了，丢掉最旧的一半再试。
            const AHEAD_SECONDS = 30;
            let element: HTMLAudioElement | null = null;
            const findElement = () => (
                typeof document === 'undefined'
                    ? null
                    : [...document.querySelectorAll('audio')].find(a => a.src === objectUrl || a.currentSrc === objectUrl) ?? null
            );
            const bufferedEnd = () => (
                sourceBuffer.buffered.length ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) : 0
            );
            const waitForRoom = async () => {
                if (!element) element = findElement();
                if (!element) return;
                // 暂停时也按同一把尺子：停在 0 秒就只填 30 秒，按下播放再继续，不会先把整首塞满。
                for (let waited = 0; waited < 60000; waited += 250) {
                    if (bufferedEnd() - element.currentTime <= AHEAD_SECONDS) return;
                    await sleep(250);
                }
            };

            const appendPaced = async (chunk: ArrayBuffer) => {
                await waitForRoom();
                for (let attempt = 0; attempt < 5; attempt += 1) {
                    try {
                        await append(chunk);
                        return;
                    } catch (error) {
                        const name = (error as { name?: string } | null)?.name;
                        if (name !== 'QuotaExceededError' && name !== 'QuotaExceededErr') throw error;
                        await evictOldest(0.5);
                    }
                }
                throw new Error('sourcebuffer quota');
            };

            await appendPaced(head);
            let position = head.byteLength;
            // 下载已经结束、但有一段始终取不到（边界上少几个字节、上游提前断开）时的轮数。
            // 不能无限等：endOfStream 不调用，MediaSource 的 duration 就永远是 Infinity。
            let stalledRounds = 0;

            for (;;) {
                const state = status.call(bridge, token);
                const received = progress.call(bridge, token);
                const before = position;
                while (position < received) {
                    const end = Math.min(received, position + MSE_CHUNK_BYTES);
                    const chunk = await fetchShellRange(token, position, end - 1);
                    if (!chunk) break;
                    await appendPaced(chunk);
                    position += chunk.byteLength;
                }
                const finished = state === 'ready' || state === 'failed' || state === 'missing';
                if (finished && position >= progress.call(bridge, token)) {
                    if (mediaSource.readyState === 'open') {
                        // 失败收尾时给 'network'：让播放器知道后面没有数据了，而不是等下去。
                        if (state === 'ready') mediaSource.endOfStream();
                        else mediaSource.endOfStream('network');
                    }
                    return;
                }
                if (finished) {
                    stalledRounds = position === before ? stalledRounds + 1 : 0;
                    if (stalledRounds >= 5) {
                        console.warn('[ShellAudio] stream finished with a gap, closing it', {
                            position,
                            received: progress.call(bridge, token),
                        });
                        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                        return;
                    }
                }
                await sleep(120);
            }
        } catch (error) {
            console.warn('[ShellAudio] streaming append failed', error);
        }
    })();

    console.log('[ShellAudio] streaming via MediaSource');
    return { audioSrc: objectUrl, blobUrl: objectUrl };
};

/**
 * 等壳把整首取进内存，返回 token；不可用（壳没有新桥方法 / 取失败 / 超时）返回 null。
 */
const prepareToken = async (url: string, bridge: ShellMediaBridge): Promise<number | null> => {
    const status = bridge.mediaStatus;
    if (!status) return null;

    const token = startToken(url, bridge);
    if (token === null) return null;

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
 * 让壳**提前**把某一首取进内存，不等它真的被播放。
 *
 * 切歌慢的根因是整首下载：壳要先把 ~10 MB 取完，页面才拿得到 blob。预取下一首能把这
 * 几秒挪到上一首播放期间——真正切过去时只剩 200 ms 左右的本地 blob 拷贝。
 * 失败一律吞掉：预取是加速手段，不能影响任何播放路径。
 */
export const prefetchShellAudio = (url: string | null | undefined): void => {
    if (!url || !needsShellAudioRelay(url)) return;
    if (tokenByRemoteUrl.has(url)) return;

    const bridge = shellBridge();
    const prepare = bridge?.mediaPrepare;
    if (!bridge || !prepare) return;

    try {
        const token = prepare.call(bridge, url);
        if (typeof token === 'number' && token >= 0) {
            tokenByRemoteUrl.set(url, token);
            if (tokenByRemoteUrl.size > 4) {
                const oldest = tokenByRemoteUrl.keys().next();
                if (!oldest.done) tokenByRemoteUrl.delete(oldest.value);
            }
            console.log('[ShellAudio] prefetching the next track into shell memory');
        }
    } catch (error) {
        console.warn('[ShellAudio] prefetch failed, ignored', error);
    }
};

/**
 * 把远程音频地址变成同源地址。
 *
 * 失败时**回退到原地址**：让原有播放链路自己报错，比在这里伪装成功更好排查。
 */
export const materializeShellAudioSource = async (
    url: string,
    knownDurationSec?: number,
): Promise<{ audioSrc: string; blobUrl?: string }> => {
    if (!needsShellAudioRelay(url)) {
        return { audioSrc: url };
    }

    const bridge = shellBridge();
    if (bridge) {
        // 先试流式：mp3 边下边放，首声只等第一块（~64 KB）。
        // flac 之类 MSE 放不了的，会在这里返回 null，落到下面的 blob 路径。
        try {
            const streamed = await streamViaMse(url, bridge, knownDurationSec);
            if (streamed) {
                return { audioSrc: streamed.audioSrc, ...(streamed.blobUrl ? { blobUrl: streamed.blobUrl } : {}) };
            }
        } catch (error) {
            console.warn('[ShellAudio] streaming path failed, trying the blob path', error);
        }

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
