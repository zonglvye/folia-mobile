import { webview } from '@kit.ArkWeb';
import { ShellLog } from './ShellLog';
import { NetworkMonitor } from './NetworkMonitor';

// harmony/entry/src/main/ets/shell/WebNeteaseBridge.ets
//
// 把网易云的接口请求**放进 ArkWeb 页面里发**，而不是用壳的系统网络栈（`@ohos.net.http`）。
//
// 为什么必须这样：真机实测同一份 cookie、同一个加密 body、同样长度的请求，
//   - 系统网络栈（`@ohos.net.http`）→ 服务端回 `{code:200, account:null, profile:null}`（当成未登录），
//     扫码登录的最后一步也被判 `8821 环境风险`；
//   - 电脑上的 curl / 参考实现（Node）→ 同一个请求拿到完整账号；
//   - **ArkWeb 页面里同源 fetch** → 同样拿到完整账号。
// 也就是说网易按客户端指纹判断，壳里这套 HTTP 栈过不去，而页面用的是真 Chromium。
//
// 通道形状：壳 → `runJavaScript` 注入一段 fetch → 页面拿到响应后调回这里的同步桥方法 `done(id, json)`。
// 同步桥方法是唯一实测可靠的跨语言回调（见 FoliaBridge.proxyStart 的注释）。

/** 页面回来的结果：`{status, body}`，body 是响应原文（JSON.stringify 转义过，不需要再解 base64）。 */
interface WebFetchReply {
  status: number;
  body: string;
}

/**
 * 一次中继请求的结局。
 *
 * `outcome` 必须区分「中继页不可用」和「网络失败」：
 *   - unavailable：页面没就绪 / 注入失败 —— 只有这种情况才该退回系统网络栈（冷启动时它还能用）；
 *   - network：请求确实发出去了但没拿到响应（断网、挂起、超时）—— 这时**绝不能**退回系统栈：
 *     那条路在网易眼里是另一个客户端，会回 `account:null`，把「断网」变成「登录失效」。
 */
interface RelayReply {
  outcome: string;
  status: number;
  body: string;
}

/** 中继页所在的源，也是会话 cookie 的作用域。 */
const NETEASE_ORIGIN: string = 'https://music.163.com/';

/** `runJavaScript` 里的脚本模板：结果一律回调到 `done`，异常也回调，避免壳这边一直等。 */
const SCRIPT_TEMPLATE = (id: number, target: string, method: string, headersJson: string, bodyJson: string): string => (
  `(function(){try{fetch(${target}, {method: ${method}, headers: ${headersJson}, credentials: 'include'${bodyJson.length > 2 ? `, body: ${bodyJson}` : ''}})`
  + `.then(function(r){return r.text().then(function(t){`
  + `window.${WebNeteaseBridge.NAME}.done(${id}, JSON.stringify({status: r.status, body: t}));`
  + `});})`
  + `.catch(function(e){window.${WebNeteaseBridge.NAME}.done(${id}, JSON.stringify({status: 0, body: '', error: String(e)}));});`
  + `}catch(e){window.${WebNeteaseBridge.NAME}.done(${id}, JSON.stringify({status: 0, body: '', error: String(e)}));}})()`
);

export class WebNeteaseBridge {
  /** 桥对象名：页面里用 `window.foliaWebNet.done(...)` 回调。 */
  static readonly NAME: string = 'foliaWebNet';
  /** javaScriptProxy 必须显式列方法名（ArkWeb 不会枚举原型）。 */
  static readonly METHODS: string[] = ['done'];

  private static controller: webview.WebviewController | null = null;
  private static ready: boolean = false;
  private static nextId: number = 1;
  /** 中继页的「生命代次」：页面重载 / 判定失效时 +1，等结果的人据此立刻退出，不再傻等 20 秒。 */
  private static generation: number = 0;
  /** 在途请求：id → 结果 JSON（空串表示还没回来）。 */
  private static pending: Map<number, string> = new Map<number, string>();

  /** 页面加载完（origin 已建立）才允许走这条路。 */
  static attach(controller: webview.WebviewController): void {
    WebNeteaseBridge.controller = controller;
  }

  static markReady(): void {
    WebNeteaseBridge.ready = true;
  }

  static markNotReady(): void {
    WebNeteaseBridge.ready = false;
    // 页面已经换掉了，在等结果的请求永远不会回来：换代次 + 清表，让它们立即返回 unavailable。
    WebNeteaseBridge.generation += 1;
    WebNeteaseBridge.pending.clear();
  }

  static isReady(): boolean {
    return WebNeteaseBridge.ready && WebNeteaseBridge.controller !== null;
  }

  /**
   * 「中继页能不能用」以**能不能在正确的源上跑 JS** 为准，不能只看 onPageEnd。
   *
   * 真机实测（2026-10）：music.163.com 这个页面会长时间停在 `readyState: 'interactive'`，
   * load 事件迟迟不来 —— onPageEnd 于是永远不触发，`ready` 一直是 false，所有请求都退回壳的
   * 系统网络栈。而那条路是被网易按客户端指纹判成未登录的（日志里 `musicU=0`、
   * `{code:200,account:null,profile:null}`、歌曲地址 `code -110`），用户看到的就是
   * 「明明登录过，突然全都没登录了」。其实只要注入得进去、源对得上，同源 fetch 立刻就能用。
   */
  private static async ensureReady(controller: webview.WebviewController): Promise<boolean> {
    if (WebNeteaseBridge.ready) {
      return true;
    }
    try {
      const origin = await controller.runJavaScript('location.origin');
      const text = String(origin);
      if (text.includes('music.163.com')) {
        WebNeteaseBridge.ready = true;
        ShellLog.info(`netease relay ready by origin probe: ${text}`);
        return true;
      }
      ShellLog.info(`netease relay not ready yet (origin=${text})`);
    } catch (error) {
      ShellLog.info(`netease relay origin probe failed: ${String(error)}`);
    }
    return false;
  }

  /** 页面回调入口（同步桥方法）。 */
  done(id: number, payloadJson: string): void {
    WebNeteaseBridge.pending.set(id, payloadJson);
  }

  /**
   * 取中继页当前的网易会话 cookie（`k=v; k=v`）。
   *
   * 扫码确认那一步（code 803）的 Set-Cookie 是**浏览器**收下的，壳里看不到响应头，
   * 所以只能事后从 webview 的 cookie 罐里读出来，装进信封交给页面写进它自己的会话存储。
   */
  static async harvestCookie(): Promise<string> {
    try {
      return await webview.WebCookieManager.fetchCookie(NETEASE_ORIGIN);
    } catch (error) {
      ShellLog.warn(`netease cookie harvest failed: ${(error as Error).message}`);
      return '';
    }
  }

  /**
   * 在页面里发一次请求并等结果。
   *
   * 返回的 `outcome` 决定调用方能不能退回系统网络栈（见 RelayReply 的注释）：
   * 只有页面本身不可用时才可以退；请求发出去之后失败的一律按网络失败处理，否则断网会被
   * 系统栈回成 `account:null`，表现成「突然全都没登录」。
   */
  static async request(
    target: string,
    method: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<RelayReply> {
    const offline: RelayReply = { outcome: 'network', status: 0, body: '' };
    const unavailable: RelayReply = { outcome: 'unavailable', status: 0, body: '' };

    const controller = WebNeteaseBridge.controller;
    if (controller === null) {
      return unavailable;
    }
    // 断网时页面里的 fetch 会挂住（真机实测），不必再问它。
    if (!NetworkMonitor.isOnline()) {
      ShellLog.info(`netease relay skipped (offline): ${target}`);
      return offline;
    }
    if (!(await WebNeteaseBridge.ensureReady(controller))) {
      return unavailable;
    }
    if (!NetworkMonitor.isOnline()) {
      return offline;
    }

    // 冷启动后的头一两秒里，中继页可能正好在导航，fetch 会以 `TypeError: Failed to fetch` 失败。
    // 这种失败重试一次就好，不能直接当断网 —— 否则启动时的播放恢复、喜欢列表都会失败。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await WebNeteaseBridge.attemptOnce(controller, target, method, headers, body);
      if (reply.outcome !== 'network' || attempt > 0 || !NetworkMonitor.isOnline()) {
        return reply;
      }
      ShellLog.info(`netease relay retrying after page failure: ${target}`);
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 300);
      });
    }
    return offline;
  }

  /** 发一次并等结果；页面没就绪 / 被换代次 / 断网都在这里分好类。 */
  private static async attemptOnce(
    controller: webview.WebviewController,
    target: string,
    method: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<RelayReply> {
    const offline: RelayReply = { outcome: 'network', status: 0, body: '' };
    const unavailable: RelayReply = { outcome: 'unavailable', status: 0, body: '' };

    const id = WebNeteaseBridge.nextId;
    WebNeteaseBridge.nextId += 1;
    WebNeteaseBridge.pending.set(id, '');
    const generation = WebNeteaseBridge.generation;

    const script = SCRIPT_TEMPLATE(
      id,
      JSON.stringify(target),
      JSON.stringify(method),
      JSON.stringify(headers),
      JSON.stringify(body),
    );
    try {
      await controller.runJavaScript(script);
    } catch (error) {
      WebNeteaseBridge.pending.delete(id);
      ShellLog.warn(`netease relay inject failed: ${(error as Error).message}`);
      return unavailable;
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      // 页面被换掉了（网络恢复后重载中继页、或用户退出登录页触发了导航）：等下去没有意义。
      if (WebNeteaseBridge.generation !== generation) {
        WebNeteaseBridge.pending.delete(id);
        ShellLog.info(`netease relay reloaded while waiting: ${target}`);
        return unavailable;
      }
      // 等待期间断网：立刻失败，别等 20 秒超时。
      if (!NetworkMonitor.isOnline()) {
        WebNeteaseBridge.pending.delete(id);
        ShellLog.warn(`netease relay lost network while waiting: ${target}`);
        return offline;
      }
      const value = WebNeteaseBridge.pending.get(id);
      if (value !== undefined && value.length > 0) {
        WebNeteaseBridge.pending.delete(id);
        try {
          const reply = JSON.parse(value) as WebFetchReply;
          if (reply.status <= 0) {
            ShellLog.warn(`netease relay failed in page: ${value.slice(0, 160)}`);
            return offline;
          }
          return { outcome: 'ok', status: reply.status, body: reply.body };
        } catch (error) {
          ShellLog.warn(`netease relay reply unreadable: ${value.slice(0, 120)}`);
          return offline;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 40);
      });
    }

    WebNeteaseBridge.pending.delete(id);
    ShellLog.warn(`netease relay timeout: ${target}`);
    return offline;
  }

  /**
   * 网络恢复后重新武装中继页。
   *
   * 断网时如果中继页还没加载完，ArkWeb 会停在一张错误页上；之后网络回来了也没有东西会再导航一次，
   * 于是 `location.origin` 永远不是 music.163.com，所有请求都退回系统栈 —— 表现就是「明明登录过，
   * 突然全都没登录」。所以恢复时要探一次源，不对就重新 loadUrl。
   */
  static async onNetworkRestored(): Promise<void> {
    const controller = WebNeteaseBridge.controller;
    if (controller === null) {
      return;
    }
    // 旧页面上在等的请求已经不可能回来了。
    WebNeteaseBridge.markNotReady();

    let origin = '';
    try {
      origin = String(await controller.runJavaScript('location.origin'));
    } catch (error) {
      ShellLog.warn(`netease relay probe after network failed: ${String(error)}`);
    }
    if (origin.indexOf('music.163.com') >= 0) {
      WebNeteaseBridge.ready = true;
      ShellLog.info(`netease relay re-armed: ${origin}`);
      return;
    }
    ShellLog.info(`netease relay reloading after network: origin=${origin}`);
    try {
      controller.loadUrl(NETEASE_ORIGIN);
    } catch (error) {
      ShellLog.warn(`netease relay reload failed: ${String(error)}`);
    }
  }
}
