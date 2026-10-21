import { common } from '@kit.AbilityKit';

// harmony/entry/src/main/ets/shell/AssetServer.ets
// 把打包进 HAP 的 web 构建当成一个网站发出去 —— 和安卓壳 FoliaAssetHandler 一一对应。
//
// 为什么必须这么做，而不是 file:// 或直接吃 rawfile：
//   · 这个应用的曲库、主题、歌词、媒体缓存全在 IndexedDB / Cache Storage 里，而这两样只对**安全上下文**
//     开放；file:// 页面不算安全上下文，会静默失效。
//   · 用 https origin + onInterceptRequest 应答，页面的 origin 就是一个正常的 https 站点（沿用安卓壳的
//     `appassets.androidplatform.net`），Vite 产物里的绝对路径 `/assets/index-<hash>.js` 不用改。
//
// 这里只服务于这个 origin；其它 url 一律返回 null，让 ArkWeb 按正常网络请求走（在线歌曲、歌词）。
export class AssetServer {
  /** 与安卓壳一致的虚拟 origin（换掉它等于换 origin，IndexedDB 会全部重来）。 */
  static readonly ORIGIN: string = 'https://appassets.androidplatform.net';
  /** rawfile 下的目录名（tools/sync-web-assets.ps1 把 web/dist 拷到这里）。 */
  private static readonly ROOT: string = 'www';
  /** index.html 里没有 service worker 的位置：壳的离线是结构性的，见 web/src/index.tsx 的说明。 */
  private static readonly INDEX: string = 'index.html';

  private readonly context: common.UIAbilityContext;
  /** 读到过的字节：整包十兆上下，命中一次就够，别每次请求都去解 rawfile。 */
  private readonly cache: Map<string, Uint8Array> = new Map<string, Uint8Array>();

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 这个 url 是不是我们的虚拟站点。 */
  static owns(url: string): boolean {
    return url.startsWith(AssetServer.ORIGIN);
  }

  /**
   * 应答一次请求；返回 null 表示「不归我管」。
   *
   * 目录与未知路径一律回 index.html：SPA 的路由不经过服务端，刷新时必须回同一份 HTML。
   */
  handle(url: string): WebResourceResponse | null {
    if (!AssetServer.owns(url)) {
      return null;
    }
    const path = AssetServer.normalizePath(url);
    const bytes = this.read(path);
    if (bytes === null) {
      return null;
    }

    // WebResourceResponse / WebResourceRequest 在 ArkTS 里是 `component/web.d.ts` 的全局类，
    // **不在 `@kit.ArkWeb` 的 webview 命名空间里**（那里只有 WebviewController 等），
    // 所以这里不 import、不加前缀。可以用的构造方式也只有无参构造 + setter。
    const response = new WebResourceResponse();
    response.setResponseMimeType(AssetServer.mimeFor(path));
    response.setResponseEncoding('utf-8');
    // 只有「视图正好覆盖整个 ArrayBuffer」时才能直接给 buffer，否则会把数组前后的多余字节一起发出去，
    // 页面拿到的就是一段坏掉的 JS。
    response.setResponseData(AssetServer.exactBuffer(bytes));
    response.setResponseCode(200);
    response.setReasonMessage('OK');
    // 必须是 no-store，不能是 no-cache（只要求「用前重新验证」，而没有 ETag 时验证无从谈起）。
    //
    // 实测代价：懒加载 chunk 的 CSS 换了文件名，页面却还在用上一版——它命中缓存里的旧 chunk JS，
    // 再按里面写的旧 URL 去要 CSS；而那个 URL 早就不在 rawfile 里了，照样被缓存喂回来。
    // 表现就是「改了样式、装了包、真机没变」，极难往缓存上想。这里的资源本来就是内容哈希命名的，
    // 没有任何缓存收益，直接禁掉。
    response.setResponseHeader([{ headerKey: 'Cache-Control', headerValue: 'no-store' }]);
    return response;
  }

  private static exactBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer as ArrayBuffer;
    }
    return bytes.slice().buffer as ArrayBuffer;
  }

  /** `https://host/path?q#f` → `path`（去掉查询与哈希，缺省回 index.html）。 */
  private static normalizePath(url: string): string {
    let rest = url.slice(AssetServer.ORIGIN.length);
    const query = rest.indexOf('?');
    if (query >= 0) {
      rest = rest.slice(0, query);
    }
    const hash = rest.indexOf('#');
    if (hash >= 0) {
      rest = rest.slice(0, hash);
    }
    if (rest.length === 0 || rest === '/') {
      return AssetServer.INDEX;
    }
    return rest.startsWith('/') ? rest.slice(1) : rest;
  }

  /** 读 rawfile 里的一个文件；找不到就退回 index.html（SPA 刷新与深链接）。 */
  private read(path: string): Uint8Array | null {
    const cached = this.cache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    const exact = this.readRaw(`${AssetServer.ROOT}/${path}`);
    if (exact !== null) {
      this.cache.set(path, exact);
      return exact;
    }

    // 只有「看起来像前端路由」的路径才退回 index.html。三类必须拒绝：
    //   · index.html 自己 —— 再退就是死循环
    //   · api/ 下的路径 —— 那是壳自己的代理端点，由 HttpProxy 应答（它排在前面，这里只是护栏）
    //   · 带扩展名的路径 —— 缺的 .js / .css 该是 404；把 HTML 当脚本发回去只会得到一句
    //     莫名其妙的语法错误，排查起来比 404 难十倍
    if (path === AssetServer.INDEX || path.startsWith('api/') || AssetServer.hasExtension(path)) {
      return null;
    }
    // 退回的那一份**不进 cache**：否则每一条不存在的路径都会各存一份 index.html，
    // 十兆的缓存会长成一个按请求数增长的泄漏。
    return this.readRaw(`${AssetServer.ROOT}/${AssetServer.INDEX}`);
  }

  /** 最后一段里有没有点，即「这是不是一个具体文件」而不是一条前端路由。 */
  private static hasExtension(path: string): boolean {
    const slash = path.lastIndexOf('/');
    const last = slash >= 0 ? path.slice(slash + 1) : path;
    return last.indexOf('.') > 0;
  }

  private readRaw(assetPath: string): Uint8Array | null {
    try {
      return this.context.resourceManager.getRawFileContentSync(assetPath);
    } catch (error) {
      // 缺文件是正常路径（SPA 深链接、favicon），不是异常：安静地交给调用方退回 index.html。
      return null;
    }
  }

  private static mimeFor(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
    switch (ext) {
      case 'html': return 'text/html';
      case 'js':
      case 'mjs': return 'text/javascript';
      case 'css': return 'text/css';
      case 'json': return 'application/json';
      case 'svg': return 'image/svg+xml';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'gif': return 'image/gif';
      case 'woff2': return 'font/woff2';
      case 'woff': return 'font/woff';
      case 'ttf': return 'font/ttf';
      case 'wasm': return 'application/wasm';
      case 'mp3': return 'audio/mpeg';
      case 'm4a': return 'audio/mp4';
      case 'flac': return 'audio/flac';
      // 未知的按二进制发：发成 text 会让 ArkWeb 改字符集。
      default: return 'application/octet-stream';
    }
  }
}
