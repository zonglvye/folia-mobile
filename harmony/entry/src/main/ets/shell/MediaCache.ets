import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ShellLog } from './ShellLog';
import { NetworkMonitor } from './NetworkMonitor';

// harmony/entry/src/main/ets/shell/MediaCache.ets
//
// 在线音频的**内存缓存 + 同源回放**。
//
// 为什么要有它：网易下发的音频地址不带 CORS 头（`authSecret` / `cdntag=mark=os_web` 那种签名地址），
// 页面里的 `<audio crossOrigin="anonymous">` 加载即失败；而可视化要 WebAudio 分析，必须走 CORS 同源。
// 第一种做法是让页面按 1MiB 分块经代理取回、拼成 blob：能用，但一份 50MB 的无损文件要过五十次
// base64（每次 1.4MB 字符串，全在主线程上解码）—— 真机上表现为切歌等很久、整机发卡。
//
// 现在的做法：壳用系统网络栈一次把音频取成 `ArrayBuffer`（不经过 JS 字符串），
// 页面用 `/api/media-proxy?token=…` 取它，拦截器（`onInterceptRequest`）同步返回这段字节。
// ArkWeb 直接拿到二进制，页面侧没有任何 base64 开销，也不需要 blob。
//
// 生命周期：页面在换歌后调 `mediaRelease`；只留最后两条，避免把内存拖成几百 MB。

const CONNECT_TIMEOUT_MS: number = 10000;
const READ_TIMEOUT_MS: number = 60000;

/** 一条缓存：状态 + 字节 + mime。字段名只在本文件里用。 */
export interface MediaEntry {
  state: string;
  data: ArrayBuffer | null;
  mime: string;
  /** 字节总数，Range 计算用（data 非空时等于 data.byteLength）。 */
  size: number;
}

export class MediaCache {
  private static entries: Map<number, MediaEntry> = new Map<number, MediaEntry>();
  private static nextToken: number = 1;

  /** 开始取一首歌；同步返回 token，页面轮询 `status`。 */
  static prepare(url: string): number {
    const token = MediaCache.nextToken;
    MediaCache.nextToken += 1;
    const entry: MediaEntry = { state: 'pending', data: null, mime: 'audio/mpeg', size: 0 };
    MediaCache.entries.set(token, entry);
    MediaCache.evictOldest();

    // 断网：连接超时要 10 秒，页面那边 30 秒就放弃去拼 blob 了，等下去只会更慢。直接判失败，
    // 页面按网络失败展示，网络恢复后由断网重连重新 prepare。
    if (!NetworkMonitor.isOnline()) {
      entry.state = 'failed';
      ShellLog.info(`media prepare skipped (offline) token=${token}`);
      return token;
    }

    const client = http.createHttp();
    client.request(url, {
      method: http.RequestMethod.GET,
      header: { 'Accept-Encoding': 'identity', 'Range': 'bytes=0-' },
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
      usingCache: false,
      usingProtocol: http.HttpProtocol.HTTP1_1,
    }).then((response: http.HttpResponse) => {
      const buffer = response.result as ArrayBuffer;
      if (buffer === undefined || buffer === null || buffer.byteLength === 0) {
        entry.state = 'failed';
        ShellLog.warn(`media prepare empty: code=${response.responseCode} ${url.slice(0, 90)}`);
      } else {
        entry.data = buffer;
        entry.size = buffer.byteLength;
        entry.mime = MediaCache.mimeOf(response.header);
        entry.state = 'ready';
        ShellLog.info(`media ready: ${entry.size} bytes ${entry.mime} token=${token}`);
      }
      client.destroy();
    }).catch((error: BusinessError) => {
      entry.state = 'failed';
      ShellLog.warn(`media prepare failed: code=${error.code} msg=${error.message}`);
      client.destroy();
    });

    return token;
  }

  static status(token: number): string {
    const entry = MediaCache.entries.get(token);
    return entry === undefined ? 'missing' : entry.state;
  }

  /** 拦截器用：拿一条就绪的缓存（没就绪返回 null，绝不阻塞）。 */
  static view(token: number): MediaEntry | null {
    const entry = MediaCache.entries.get(token);
    if (entry === undefined || entry.state !== 'ready' || entry.data === null) {
      return null;
    }
    return entry;
  }

  static release(token: number): void {
    MediaCache.entries.delete(token);
  }

  /** 最多留两条（当前 + 上一首淡出用）；超出的先丢最老的。 */
  private static evictOldest(): void {
    while (MediaCache.entries.size > 2) {
      let oldest: number = -1;
      MediaCache.entries.forEach((_value: MediaEntry, key: number) => {
        if (oldest < 0 || key < oldest) {
          oldest = key;
        }
      });
      if (oldest < 0) {
        return;
      }
      MediaCache.entries.delete(oldest);
      ShellLog.info(`media evicted token=${oldest}`);
    }
  }

  private static mimeOf(header: Object): string {
    if (header === null || header === undefined) {
      return 'audio/mpeg';
    }
    const table = header as Record<string, string>;
    for (const key of Object.keys(table)) {
      if (key.toLowerCase() !== 'content-type') {
        continue;
      }
      const value = table[key];
      if (typeof value === 'string' && value.length > 0) {
        // 去掉 charset，媒体类型不需要它。
        const semicolon = value.indexOf(';');
        const mime = semicolon > 0 ? value.slice(0, semicolon).trim() : value;
        // CDN 有时不给 content-type，回 octet-stream。真机上媒体元素拿到它以后会卡在已缓冲的
        // 一两秒（后续 Range 请求全失败），而音频是页面按 mp3 要的，统一按 audio/mpeg 交出去。
        return mime.toLowerCase().indexOf('audio/') === 0 ? mime : 'audio/mpeg';
      }
    }
    return 'audio/mpeg';
  }
}
