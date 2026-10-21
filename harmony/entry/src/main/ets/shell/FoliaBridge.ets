import { PlaybackSession } from './PlaybackSession';
import { HttpProxy } from './HttpProxy';
import type { ProxyResult } from './HttpProxy';
import { MediaCache } from './MediaCache';
import { ShellLog } from './ShellLog';

// harmony/entry/src/main/ets/shell/FoliaBridge.ets
// 页面里的 `window.foliaAndroid`（沿用安卓壳的名字，web 层零改动）。
//
// web 层对桥只有一个硬依赖：`services/deviceAudioLibrary.ts` 会探测 `hasAudioPermission` /
// `requestAudioPermission`，`utils/platform.ts` 用「这个对象在不在」判断自己是否跑在打包壳里
// （在壳里才会：走壳内网易云本地实现、默认 60 帧、注销 service worker）。
//
// 所以这个对象必须在**页面脚本执行之前**就注册好，否则 web 层会把自己当成浏览器环境。
//
// 设备音乐库（安卓侧的 MediaStore）在鸿蒙上还没有对应实现（见 PORT.md 风险 1）：
// 两个权限方法先老实返回 false，让 web 层把「设备曲库」这条路关掉，而不是给出一个空列表。
//
// 安卓壳里那几个 web 层从未调用过的方法（getAppInfo / setImmersiveMode /
// openBatteryOptimizationSettings）这边**故意不实现**：方法不存在，页面的能力探测才是诚实的。
export class FoliaBridge {
  /** 桥的名字：必须与 web 层探测的一致。 */
  static readonly NAME: string = 'foliaAndroid';
  /** javaScriptProxy 要显式列出的方法名（ArkWeb 不会枚举类的原型）。 */
  static readonly METHODS: string[] = [
    'hasAudioPermission',
    'requestAudioPermission',
    'getShellKind',
    'setPlaybackSnapshot',
    // 页面往日志里写一行。真机上 console 读不出来（见 ShellLog），排查页面侧问题时只能靠它。
    'report',
    // 同源代理：发起 + 轮询。**全部同步**，见 proxyStart 的注释。
    'proxyStart',
    'proxyPoll',
    // 拉起壳内置的网易云登录页（真浏览器里登录，见 Index.ets 的 LoginOverlay）。
    'openNeteaseLogin',
    // 在线音频的同源回放：页面让壳把整首取进内存，再用 /api/media-proxy?token=… 取回。
    // 三个方法全是同步的（同 proxyStart/proxyPoll 的理由），见 MediaCache。
    'mediaPrepare',
    'mediaStatus',
    'mediaRelease',
  ];

  private readonly session: PlaybackSession;

  /** 在途的代理请求：id → 结果 JSON（空串表示还在取）。见 proxyStart。 */
  private readonly proxyResults: Map<number, string> = new Map<number, string>();
  private nextProxyId: number = 1;

  constructor(session: PlaybackSession) {
    this.session = session;
  }

  /** 安卓壳里这是 READ_EXTERNAL_STORAGE/MEDIA 的结果；鸿蒙这边设备曲库未实现，先报 false。 */
  hasAudioPermission(): boolean {
    return false;
  }

  /** 同上：不申请一个用不到的权限，免得用户被弹窗打扰。 */
  requestAudioPermission(): boolean {
    return false;
  }

  /**
   * 告诉页面这是哪个壳。
   *
   * 页面用这个答案决定要不要把播放快照推上来（services/shellNowPlaying.ts）。不能改成
   * 「setPlaybackSnapshot 存不存在」——那个方法安卓壳也声明了，但它的前台服务从没在任何机器上
   * 跑过，页面一启动它就是把「没有通知」换成「可能没有播放」。安卓壳继续不作答，保持沉默。
   */
  getShellKind(): string {
    return 'harmony';
  }

  /**
   * 页面推过来的播放快照（约 1 秒一次），转给 AVSession 镜像到锁屏与控制中心。
   * 页面永远是播放状态的唯一真相，壳只镜像。
   */
  setPlaybackSnapshot(snapshotJson: string): void {
    this.session.applySnapshotJson(snapshotJson);
  }

  /**
   * 页面侧的日志入口。ArkTS 的 console 在真机上读不出来，所以页面要留痕就调这个：
   *   window.foliaAndroid.report('I', '...')
   * 落在同一个沙箱文件里（见 ShellLog），和壳日志按时间交错，能对上前后因果。
   */
  report(level: string, message: string): void {
    const line = `page: ${message}`;
    if (level === 'E') {
      ShellLog.error(line);
    } else if (level === 'W') {
      ShellLog.warn(line);
    } else {
      ShellLog.info(line);
    }
  }

  /**
   * 同源代理：页面把 `/api/lyric-proxy`、`/api/netease-proxy` 的 fetch 接到这里。
   *
   * 为什么不用 onInterceptRequest：那个回调必须是同步的。先返回空响应、拿到上游数据再
   * setResponseData 回填的写法在真机上不生效 —— 页面拿到空 body，表现为「网易云登录错误、
   * 二维码不出来」。
   *
   * 为什么也不用 asyncMethodList（异步桥方法）：真机上方法确实被调到了、上游也确实成功，
   * 但页面那边的 Promise 永远不 resolve（日志里只有 `proxy ->`，没有 `proxy <-`）。
   * 所以改成两个**同步**方法配对：
   *   const id = proxyStart(url)   → 立刻返回 id，后台开始取
   *   proxyPoll(id)                → '' 表示还在取，否则返回结果 JSON（只取一次）
   * 同步方法在这个桥上是确定可用的（setPlaybackSnapshot 每秒一次就是这个形状）。
   */
  proxyStart(requestUrl: string): number {
    const id = this.nextProxyId;
    this.nextProxyId += 1;
    this.proxyResults.set(id, '');
    HttpProxy.execute(requestUrl).then((result: ProxyResult) => {
      this.proxyResults.set(id, JSON.stringify(result));
    }).catch(() => {
      ShellLog.error(`proxy failed: ${requestUrl.slice(0, 120)}`);
      const failed: ProxyResult = { status: 502, mime: 'application/json', charset: 'utf-8', body: '' };
      this.proxyResults.set(id, JSON.stringify(failed));
    });
    return id;
  }

  /** 取一次结果：空串表示还没好（或者 id 不存在），页面继续轮询。 */
  proxyPoll(id: number): string {
    const value = this.proxyResults.get(id);
    if (value === undefined || value.length === 0) {
      return '';
    }
    this.proxyResults.delete(id);
    return value;
  }

  /**
   * 打开壳内置的网易云登录页。
   *
   * 为什么需要它：网易扫码登录的风控判的是**客户端环境**。真机实测同一账号、同一出口 IP：
   * 壳里用系统网络栈发扫码请求 → `8821 环境风险`；电脑上用参考实现（Node/axios）走同一套
   * 协议 → `803 登录成功`。也就是说伪造的 HTTP 客户端这一层过不去，而真浏览器一定过
   * （用户自己在浏览器里登网页版就是正常流程）。
   *
   * 所以登录整个交给 ArkWeb 里的网易云网页，登录完由 Index 侧把 cookie 写进页面的
   * `online_provider:netease:cookie`。用 AppStorage 传递可见性，桥方法保持同步。
   */
  openNeteaseLogin(): string {
    AppStorage.setOrCreate<boolean>('neteaseLoginVisible', true);
    return 'opened';
  }

  // ---- 在线音频的同源回放 --------------------------------------------------------------
  //
  // 音频地址不带 CORS 头，页面里的 <audio crossOrigin> 直接加载会失败；而可视化要 WebAudio 分析，
  // 必须同源。于是：壳把整首取进内存（二进制，不经 JS 字符串），页面用 token 从拦截器取回。
  // 三个方法都为同步 —— 这是这个桥上唯一稳定可靠的形状。

  /** 开始取一首歌，返回 token；页面随后轮询 mediaStatus。 */
  mediaPrepare(url: string): number {
    return MediaCache.prepare(url);
  }

  /** `pending` | `ready` | `failed` | `missing`。 */
  mediaStatus(token: number): string {
    return MediaCache.status(token);
  }

  /** 换歌后释放上一首（壳内部也只留最近两条，这里主要是及时放掉）。 */
  mediaRelease(token: number): void {
    MediaCache.release(token);
  }
}

// 这里曾经导出一个 `FoliaBridgeProxy` 对象字面量类型（object: / name: / methodList: / controller:）。
// 删掉的原因：ArkTS 不允许用对象字面量做类型声明（arkts-no-obj-literals-as-types），而且它没人用 ——
// 注册桥的参数是就地写在 Index.ets 的 javaScriptProxy(...) 里的。
