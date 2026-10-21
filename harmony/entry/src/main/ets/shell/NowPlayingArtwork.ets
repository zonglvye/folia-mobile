import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { ShellLog } from './ShellLog';

// harmony/entry/src/main/ets/shell/NowPlayingArtwork.ets
//
// 锁屏 / 控制中心的封面。
//
// 为什么要在壳里做：`AVMetadata.mediaImage` 要的是 `image.PixelMap`（或一个壳能打开的文件路径），
// 而页面推上来的快照里只有 URL。页面里那张封面可能还是 `blob:`（见 web 层 coverCache），壳根本取不到，
// 所以约定是：页面推**远端 https** 地址，壳自己下载 + 解码。
//
// 封面是纯装饰：任何一步失败都只是锁屏上少一张图，绝不能影响播放。所以这里全部吞异常，
// 失败返回 null，调用方照常下发没有封面的元数据。

/** 锁屏卡片上的封面按这个边长封顶。原图常是 1400×1400，整张留在内存里没必要。 */
const MAX_EDGE: number = 512;

/** 只留最近几张：切歌来回切时不用每次重新下载，又不至于把内存吃满。 */
const CACHE_SIZE: number = 4;

/** 一次下载的超时。封面慢慢来没关系，但不能把会话拖住。 */
const CONNECT_TIMEOUT_MS: number = 10000;
const READ_TIMEOUT_MS: number = 15000;

/** 缓存项。ArkTS 不接受把对象字面量类型当类型用（`type X = { ... }`），必须写成 interface。 */
interface CachedArtwork {
  url: string;
  pixelMap: image.PixelMap;
}

export class NowPlayingArtwork {
  /** 最近的封面，第一项是最新的。 */
  private static cache: CachedArtwork[] = [];

  /**
   * 取一张封面。
   *
   * 只接受 http(s)：`blob:` / `data:` 是页面自己的地址，壳取不到；空串表示没有封面。
   * 失败返回 null。
   */
  static async load(url: string): Promise<image.PixelMap | null> {
    const normalized: string = NowPlayingArtwork.normalize(url);
    if (normalized.length === 0) {
      return null;
    }

    for (let index = 0; index < NowPlayingArtwork.cache.length; index += 1) {
      const entry = NowPlayingArtwork.cache[index];
      if (entry.url === normalized) {
        // 命中就提到最前，别让它被后面几张挤掉。
        NowPlayingArtwork.cache.splice(index, 1);
        NowPlayingArtwork.cache.unshift(entry);
        return entry.pixelMap;
      }
    }

    try {
      const buffer: ArrayBuffer = await NowPlayingArtwork.download(normalized);
      const pixelMap: image.PixelMap = await NowPlayingArtwork.decode(buffer);
      NowPlayingArtwork.remember(normalized, pixelMap);
      ShellLog.info(`lock screen artwork ready: ${normalized.slice(-40)} ${pixelMap.getImageInfoSync().size.width}x${pixelMap.getImageInfoSync().size.height}`);
      return pixelMap;
    } catch (error) {
      ShellLog.warn(`lock screen artwork failed: ${String(error)}`);
      return null;
    }
  }

  /** 统一成 https 绝对地址；页面给的东西不是远端地址就返回空串。 */
  private static normalize(url: string): string {
    const trimmed: string = url.trim();
    if (trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (trimmed.startsWith('http://')) {
      return `https://${trimmed.slice(7)}`;
    }
    return '';
  }

  private static async download(url: string): Promise<ArrayBuffer> {
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
        usingCache: true,
      });
      if (response.responseCode !== 200) {
        throw new Error(`http ${response.responseCode}`);
      }
      return response.result as ArrayBuffer;
    } finally {
      client.destroy();
    }
  }

  /** 解码并缩到 MAX_EDGE 以内。锁屏那点尺寸不需要原图分辨率。 */
  private static async decode(buffer: ArrayBuffer): Promise<image.PixelMap> {
    const source: image.ImageSource = image.createImageSource(buffer);
    try {
      const info: image.ImageInfo = await source.getImageInfo();
      const width: number = info.size.width;
      const height: number = info.size.height;
      const longest: number = Math.max(width, height);
      const scale: number = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
      // createPixelMap 收的是 DecodingOptions（`desiredSize` 在这里），不是 InitializationOptions
      // （那个用的是 `size`）。两者名字很像，写错只会得到一句 "desiredSize does not exist"。
      const options: image.DecodingOptions = {
        desiredSize: {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        },
        desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
      };
      return await source.createPixelMap(options);
    } finally {
      source.release();
    }
  }

  private static remember(url: string, pixelMap: image.PixelMap): void {
    NowPlayingArtwork.cache.unshift({ url: url, pixelMap: pixelMap });
    while (NowPlayingArtwork.cache.length > CACHE_SIZE) {
      const dropped = NowPlayingArtwork.cache.pop();
      if (dropped !== undefined) {
        dropped.pixelMap.release();
      }
    }
  }
}
