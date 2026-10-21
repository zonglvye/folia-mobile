import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { AssetServer } from '../shell/AssetServer';
import { shouldClearAssetCache } from '../shell/AssetCache';
import { FoliaBridge } from '../shell/FoliaBridge';
import { MediaCache } from '../shell/MediaCache';
import { WebNeteaseBridge } from '../shell/WebNeteaseBridge';
import { playbackSession } from '../shell/PlaybackSession';
import { ShellLog } from '../shell/ShellLog';
import { NetworkMonitor } from '../shell/NetworkMonitor';

// harmony/entry/src/main/ets/pages/Index.ets
// ArkWeb 宿主：整屏一个 Web 组件，加载打包在 HAP 里的 web 构建。
//
// 三件事都在这一个拦截器里分流（顺序不能换）：
//   1. 虚拟站点的静态文件 → AssetServer（rawfile/www）
//   2. /api/lyric-proxy、/api/netease-proxy → HttpProxy（同源代理）
//   3. 其它 → 返回 null，ArkWeb 按正常网络请求走（在线歌曲、歌词、封面）
//
// 桥用 javaScriptProxy 注册成 `window.foliaAndroid`：名字沿用安卓壳，web 层不用改。
// 它必须在页面脚本执行前就位 —— 见 FoliaBridge 的文件头。
//
// 另外常驻一个 1×1 的**网易中继页**（停在 music.163.com，不可见）：网易云的接口请求在那里面
// 用同源 fetch 发，而不是走壳的系统网络栈。原因见 WebNeteaseBridge 的文件头 —— 一句话：
// 网易按客户端指纹判断，系统网络栈会被当成未登录/风控拦截，页面里的真 Chromium 才过得去。
// 登录本身也走这条路，所以 App 里原来的扫码面板原样可用，不需要任何额外的登录界面。
const NETEASE_RELAY_URL: string = 'https://music.163.com/';
/** 中继页的 UA 用桌面 Chrome：接口按网页客户端对待，和参考实现保持一致。 */
const NETEASE_RELAY_UA: string =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 在线音频的同源回放路径（页面 `<audio src>` 指到这里，见 MediaCache）。 */
const MEDIA_PATH: string = '/api/media-proxy';

/** 单个 Range 响应最多给这么多字节（原因见 mediaResponseFor）。 */
const MEDIA_CHUNK_BYTES: number = 1024 * 1024;

/** `…?token=12` 里取一个非负整数；取不到返回 -1。 */
function tokenOf(url: string): number {
  const marker = 'token=';
  const at = url.indexOf(marker);
  if (at < 0) {
    return -1;
  }
  let value = 0;
  let digits = 0;
  for (let index = at + marker.length; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    if (code < 48 || code > 57) {
      break;
    }
    value = value * 10 + (code - 48);
    digits += 1;
  }
  return digits > 0 ? value : -1;
}

function headerValueOf(headers: Array<Header>, name: string): string {
  for (const item of headers) {
    if (item.headerKey.toLowerCase() === name) {
      return item.headerValue;
    }
  }
  return '';
}

/**
 * 在线音频的应答：壳已经把整首取进内存（MediaCache），这里同步交出去。
 *
 * 现在页面的取法（见 web 的 shellOnlineAudio）：整首 `fetch` 一次拿成 Blob，再交给 `<audio>`。
 * 所以这条路上**不带 Range 的请求必须回全量 200** —— 截断会让 blob 只剩 1 MiB。
 * 带 Range 的请求按段回 206（留作兼容：媒体元素直接指到这里时用）。
 */
function mediaResponseFor(url: string, requestHeaders: Array<Header>): WebResourceResponse | null {
  if (url.indexOf(MEDIA_PATH) < 0) {
    return null;
  }
  const token = tokenOf(url);
  const entry = token >= 0 ? MediaCache.view(token) : null;
  const response = new WebResourceResponse();
  if (entry === null || entry.data === null) {
    response.setResponseCode(404);
    response.setResponseMimeType('text/plain');
    response.setResponseEncoding('utf-8');
    response.setResponseData('media not ready');
    return response;
  }

  const total = entry.size;
  let start = 0;
  let end = total - 1;
  let code = 200;
  const range = headerValueOf(requestHeaders, 'range');
  if (range.length > 0 && range.indexOf('bytes=') === 0) {
    const spec = range.slice(6);
    const dash = spec.indexOf('-');
    if (dash >= 0) {
      const startText = spec.slice(0, dash);
      const endText = spec.slice(dash + 1);
      start = startText.length > 0 ? Number(startText) : 0;
      end = endText.length > 0 ? Number(endText) : total - 1;
      if (Number.isNaN(start) || start < 0) {
        start = 0;
      }
      if (Number.isNaN(end) || end >= total) {
        end = total - 1;
      }
      if (end < start) {
        end = total - 1;
      }
      code = 206;
    }
  }

  // 只有带 Range 的请求才切 1 MiB。页面取整首（无 Range）时必须回全量 200：
  // 现在音频走「页面整首 fetch → blob」，截断会让 blob 只有 1 MiB，播到 26 秒就断。
  if (range.length > 0 && end - start + 1 > MEDIA_CHUNK_BYTES) {
    end = start + MEDIA_CHUNK_BYTES - 1;
    code = 206;
  }

  const slice = entry.data.slice(start, end + 1);
  response.setResponseCode(code);
  response.setResponseMimeType(entry.mime);
  // 不能给二进制响应设 charset：`setResponseEncoding('utf-8')` 会让 ArkWeb 按文本处理 body，
  // 遇到非法 UTF-8 序列就截断 —— 真机上表现为「播到某个时间点就 MEDIA_ERR_NETWORK」，
  // 日志里元素反复重发同一个 Range。这里不设编码，body 原样按字节送。
  response.setResponseData(slice);
  const headers: Array<Header> = [
    { headerKey: 'Accept-Ranges', headerValue: 'bytes' },
  ];
  if (code === 206) {
    headers.push({ headerKey: 'Content-Range', headerValue: `bytes ${start}-${end}/${total}` });
  }
  response.setResponseHeader(headers);
  // 媒体元素每次续读/seek 都会带 Range 进来；卡住时这行是区分「没进来」和「进来但回应无效」的唯一证据。
  ShellLog.info(`media range=${range.length > 0 ? range : '-'} start=${start} end=${end} code=${code} bytes=${slice.byteLength}`);
  return response;
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  /** 中继页的控制器：网易接口请求在这个页面上下文里发。 */
  private relayController: webview.WebviewController = new webview.WebviewController();
  /** 中继页的桥对象（页面把响应回调进来）。 */
  private netBridge: WebNeteaseBridge = new WebNeteaseBridge();
  // 会话是 EntryAbility 建起来的模块级单例：桥必须转发到同一个对象，否则系统按键会送进空气。
  private bridge: FoliaBridge = new FoliaBridge(playbackSession);
  private server: AssetServer | null = null;
  /** 启动时拿到的宿主 Context（清缓存要用到）。 */
  private hostContext: common.UIAbilityContext | null = null;

  aboutToAppear(): void {
    // getContext(this) 在这个 SDK 里已标记废弃，改用 UIContext 拿宿主 Context。
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.server = new AssetServer(context);
    this.hostContext = context;

    // 联网状态：断网时桥直接给失败（不再等 20s 超时），恢复时重新武装中继页。
    // 见 shell/NetworkMonitor 与 WebNeteaseBridge.onNetworkRestored。
    NetworkMonitor.onChange((online: boolean) => {
      ShellLog.info(`network changed -> ${online ? 'online' : 'offline'}`);
      if (online) {
        WebNeteaseBridge.onNetworkRestored();
      }
    });
  }

  /**
   * 资源缓存代次变了就清一次缓存并重新载入（见 shell/AssetCache 的文件头）。
   *
   * 必须在控制器已经绑上之后才能清：`removeCache` 是 WebviewController 的实例方法，没有静态版。
   * 清完主动 reload 一次——首次装载可能已经用旧缓存跑起来了，这一次才是新包里的资源。
   */
  private refreshAssetsIfNeeded(): void {
    const context = this.hostContext;
    if (context === null) {
      return;
    }
    shouldClearAssetCache(context).then((needed: boolean) => {
      if (!needed) {
        return;
      }
      try {
        this.controller.removeCache(true);
        this.controller.loadUrl(`${AssetServer.ORIGIN}/index.html`);
        ShellLog.info('asset cache cleared, reloading');
      } catch (error) {
        ShellLog.info(`asset cache clear failed: ${String(error)}`);
      }
    });
  }

    build() {
    Stack() {
      Column() {
        Web({ src: `${AssetServer.ORIGIN}/index.html`, controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          // 页面不需要碰本地文件系统：它要的一切都由 AssetServer 以 http 应答。
          .fileAccess(false)
          .imageAccess(true)
          .onlineImageAccess(true)
          .mediaPlayGestureAccess(true)
          .horizontalScrollBarAccess(false)
          .verticalScrollBarAccess(false)
          // 不设透明背景：页面自己画深色底，透明会让合成层每帧多做一次混合。
          .javaScriptProxy({
            object: this.bridge,
            name: FoliaBridge.NAME,
            methodList: FoliaBridge.METHODS,
            controller: this.controller,
          })
          .onControllerAttached(() => {
            // 控制器一旦可用就交给会话：之后锁屏/控制中心的按键才有地方可送。
            playbackSession.attachController(this.controller);
            // 换了前端资源就先清一次缓存，否则页面可能还在用上一版的 chunk（见 shell/AssetCache）。
            this.refreshAssetsIfNeeded();
          })
          .onInterceptRequest((event) => {
            const url = event.request.getRequestUrl();
            // 在线音频：壳已经整首取进内存，这里同步交出去（支持 Range，媒体元素靠它 seek）。
            // 走同源路径，页面侧因此没有 CORS 问题，WebAudio 分析照常。
            const media = mediaResponseFor(url, event.request.getRequestHeader());
            if (media !== null) {
              return media;
            }
            // 这里只负责打包进来的静态站点。`/api/lyric-proxy`、`/api/netease-proxy` 不在这条路上：
            // 那两个要联网，而这个回调必须是同步的（见 FoliaBridge.proxyFetch 的注释 ——
            // 「先返回空响应再回填」在真机上页面拿到的是空 body）。它们走 asyncMethodList 注册的
            // proxyFetch 桥方法，页面侧由 web/src/services/shellFetchProxy.ts 接上。
            if (this.server !== null) {
              const asset = this.server.handle(url);
              if (asset !== null) {
                return asset;
              }
            }
            return null;
          })
          .onPageEnd(() => {
            ShellLog.info('page loaded');
          })
          .onConsole((event) => {
            // 页面的 console 直方到 hilog —— 但真机上 hilog 读不出 ArkTS 的 console（见 ShellLog），
            // 所以一律转写进壳日志。排查「有数据但不播放 / 列表空着」这类问题时，页面自己说的话最准。
            ShellLog.info(`console: ${ShellLog.preview(event.message.getMessage(), 1200)}`);
            return false;
          })
          .width('100%')
          .height('100%')
      }
      .width('100%')
      .height('100%')

      // 常驻中继页：1×1 且透明，只为了给「在页面里发网易请求」提供一个真浏览器上下文。
      // 它跟 App 自己的页面共用同一个 cookie 罐，所以扫码登录成功后这里立刻就是登录态。
      Web({ src: NETEASE_RELAY_URL, controller: this.relayController })
        .userAgent(NETEASE_RELAY_UA)
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        // 中继页只需要一个**同源上下文**来发 fetch，不需要它画出任何东西：
        // 把图片与媒体都关掉，省掉首页那堆封面/轮播在后台持续解码的开销（真机上表现为发烫、切歌发卡）。
        .imageAccess(false)
        .onlineImageAccess(false)
        .mediaPlayGestureAccess(false)
        .javaScriptProxy({
          object: this.netBridge,
          name: WebNeteaseBridge.NAME,
          methodList: WebNeteaseBridge.METHODS,
          controller: this.relayController,
        })
        .onControllerAttached(() => {
          WebNeteaseBridge.attach(this.relayController);
        })
        .onPageEnd(() => {
          WebNeteaseBridge.markReady();
          ShellLog.info('netease relay ready');
        })
        // 断网时这个页面会停在错误页上：必须把 ready 清掉，否则 runJavaScript 还能注入，
        // 但 fetch 永远拿不到结果，所有请求都要等满 20 秒。
        .onErrorReceive((event) => {
          if (event.request.isMainFrame()) {
            ShellLog.warn(`netease relay page error: ${event.error.getErrorCode()} ${event.error.getErrorInfo()}`);
            WebNeteaseBridge.markNotReady();
          }
          return false;
        })
        .onDisAppear(() => {
          WebNeteaseBridge.markNotReady();
        })
        .width(1)
        .height(1)
        .opacity(0)
        .position({ x: 0, y: 0 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#070707')
  }
}
