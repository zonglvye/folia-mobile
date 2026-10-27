import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { ShellLog } from './ShellLog';
import { WebNeteaseBridge } from './WebNeteaseBridge';
import { NetworkMonitor } from './NetworkMonitor';

// harmony/entry/src/main/ets/shell/HttpProxy.ets
// 同源代理的数据层：`/api/lyric-proxy` 与 `/api/netease-proxy`。
//
// 为什么必须有：web 构建里这些查询走同源路径，因为在浏览器里直连那些主机会被 CORS 拦掉
// （响应不带 Access-Control-Allow-Origin）。网页形态下由部署端的函数应答（`api-ts/*.ts`），
// 壳里没有服务端，就只能自己应答。契约以安卓实现（LyricProxyHandler / NeteaseProxyHandler）
// 与 web 层调用方为准，不许自己发明。
//
// **这里不再产出 WebResourceResponse。** 原先靠 `onInterceptRequest` 先返回空响应、
// 拿到上游数据再 setResponseData 回填，实测在真机上页面拿到的是空 body
// （日志：`intercept filled: code=200 dataReady=true`，但页面报「登录错误」、二维码不出来，
// 且之后再没有第二个代理请求）。ArkWeb 的拦截回调是同步的，回填不保证送达。
// 所以改成：拦截器只管打包进来的静态站点，代理走 `proxyFetch` 桥方法（asyncMethodList），
// 页面侧由 services/shellFetchProxy.ts 把 fetch 接到桥上。
//
// 返回的 body 一律是 base64：封面是二进制、歌词是文本，用一条通道就不用区分，
// 解码交给页面（Response 自己按 content-type 解）。

/** 一次代理请求的结果。字段名是壳与页面之间的 wire format，别改。 */
export interface ProxyResult {
  /** 上游 HTTP 状态码。 */
  status: number;
  /** 上游 content-type（不含 charset）。 */
  mime: string;
  /** 上游 charset，没给就是空串（页面按 utf-8 处理）。 */
  charset: string;
  /** 响应体的 base64。 */
  body: string;
  /**
   * 上游响应头的 JSON（`{"bd-ticket-guard-server-data":"..."}`）。
   *
   * 为什么必须有：汽水（qishui）的登录是**票据握手**——服务端把 ticket 放在
   * `bd-ticket-guard-server-data` 这个响应头里，body 里没有。只给 body 就永远登不上，
   * 所以代理要把头也带回来。只透传正文相关的头（见 RESPONSE_HEADER_SKIP），
   * content-length / content-encoding 之类由页面自己按实际 body 重新算。
   */
  headers: string;
}

const LYRIC_PATH: string = '/api/lyric-proxy';
const NETEASE_PATH: string = '/api/netease-proxy';

const CONNECT_TIMEOUT_MS: number = 10000;
const READ_TIMEOUT_MS: number = 20000;

/** 上游默认 UA：网易按客户端类型分辨行为，缺了它会被当成异常客户端。 */
const NETEASE_DEFAULT_UA: string = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';

/** QQ 歌词主机只对「已登出的移动客户端」应答（安卓侧同样的两行）。 */
const QQ_LYRIC_HOST: string = 'u.y.qq.com';

/** 网易信封：HTTP 200 + JSON，真实状态放 status 里，Set-Cookie 放 cookie 里。 */
interface ProxyEnvelope {
  status: number;
  cookie: string;
  body: string;
}

/** 一轮网易请求的尝试方式：协议 + 压缩头。失败时按表逐轮换参数重发。 */
interface NeteasePlan {
  protocol: http.HttpProtocol;
  encoding: string;
}

export class HttpProxy {
  /**
   * 网易请求的 keep-alive 连接池（只有一格）。
   *
   * 扫码登录时页面每 2 秒轮询一次；每跳都新建 TLS 连接是浏览器绝不会有的行为，
   * 而“连接行为”本身就是风控评分项。串行调用复用这一条，并发时临时新建、用完销毁。
   */
  private static idleNeteaseClient: http.HttpRequest | null = null;

  /** 这个 url 是不是两个代理之一。 */
  static owns(url: string): boolean {
    const path = HttpProxy.pathOf(url);
    return path === LYRIC_PATH || path === NETEASE_PATH;
  }

  /**
   * 执行一次代理请求。页面经桥方法 `proxyFetch` 调到这里。
   * 不认识的路径给 404，参数不对给 400/403 —— 与部署端函数同形状。
   */
  static async execute(requestUrl: string): Promise<ProxyResult> {
    const path = HttpProxy.pathOf(requestUrl);
    if (path === LYRIC_PATH) {
      return HttpProxy.lyric(requestUrl);
    }
    if (path === NETEASE_PATH) {
      return HttpProxy.netease(requestUrl);
    }
    return HttpProxy.jsonResult(404, '{"error":"unknown proxy path"}');
  }

  // ---- /api/lyric-proxy --------------------------------------------------------------

  /**
   * 酷狗匿名签名搜索、酷狗/QQ歌词、在线封面都走这里。
   * 与安卓实现一致：透传上游状态码、mime、字符集，不自己加 Cache-Control。
   */
  private static async lyric(url: string): Promise<ProxyResult> {
    const target = HttpProxy.queryParam(url, 'url');
    if (target === null || target.length === 0) {
      return HttpProxy.jsonResult(400, '{"error":"Missing url parameter"}');
    }

    // 断网时直接给失败：这些主机用系统栈也要等 10s 连接超时，页面那边 30s 就放弃了，
    // 结果只是把失败推迟。页面自己也有一道同样的判断（shellFetchProxy），这里是兜底。
    if (!NetworkMonitor.isOnline()) {
      ShellLog.info(`lyric skipped (offline): ${target.slice(0, 90)}`);
      return HttpProxy.jsonResult(503, '{"error":"offline"}');
    }

    const parsed = HttpProxy.parseUrl(target);
    if (parsed === null) {
      return HttpProxy.jsonResult(400, '{"error":"Malformed url parameter"}');
    }
    // 只放行 http(s) + 白名单域名：这是防止页面把壳变成开放中继的唯一一处。
    const scheme = parsed.scheme.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return HttpProxy.jsonResult(403, '{"error":"Forbidden: unsupported scheme"}');
    }
    const host = parsed.host.toLowerCase();
    if (!HttpProxy.isAllowedLyricHost(host)) {
      return HttpProxy.jsonResult(403, '{"error":"Forbidden: Domain not allowed"}');
    }

    const headers: Record<string, string> = {};
    headers['Accept-Encoding'] = 'identity';
    // 音频分块：页面把 `range=start-end` 送进来，壳原样转成上游的 Range 头。
    // 整首音频走这条路时，页面按 1MiB 一块取回再拼 blob（原因见 web 的 shellOnlineAudio）。
    const range = HttpProxy.queryParam(url, 'range') ?? '';
    if (range.length > 0) {
      headers['Range'] = `bytes=${range}`;
    }
    // 登录这类接口必须 POST，且要带上客户端自己的一组头（support-calm、kg-* 之类）。
    // 页面只能给 URL，所以方法、请求体、允许的头都塞在 query 里；头名走白名单，
    // 免得这条代理变成"可以给酷狗发任意头"的通道。
    const methodParam = (HttpProxy.queryParam(url, 'method') ?? 'GET').toUpperCase();
    const isPost = methodParam === 'POST';
    if (isPost) {
      HttpProxy.applyAllowedHeaders(headers, HttpProxy.queryParam(url, 'headers'));
      const body = HttpProxy.queryParam(url, 'body') ?? '';
      // 判「页面是否已经给了 content-type」必须忽略大小写：页面的 Headers 一律小写，
      // 只查 'Content-Type' 会以为没给、再补一个 application/json，表单请求（汽水换 ticket 那条）
      // 就同时带着两种 content-type，上游按 JSON 解表单 → 参数错误。
      if (body.length > 0 && !HttpProxy.hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      const posted = await HttpProxy.perform(target, headers, body, true);
      return posted;
    }
    if (host === QQ_LYRIC_HOST) {
      headers['Cookie'] = 'tmeLoginType=-1;';
      headers['User-Agent'] = 'okhttp/3.14.9';
    } else {
      // GET 也吃这套头白名单：汽水有的 GET（播放地址二次解析、场景详情）要带客户端自己的 UA / token。
      HttpProxy.applyAllowedHeaders(headers, HttpProxy.queryParam(url, 'headers'));
    }

    return HttpProxy.perform(target, headers, '', false);
  }

  /**
   * 把页面给的头按白名单合进 headers。键大小写不敏感，值原样。
   * 只放行登录链路真正会用的那几个：多一个都算给页面开了个"随便发头"的口子。
   */
  private static applyAllowedHeaders(headers: Record<string, string>, raw: string | null): void {
    if (raw === null || raw.length === 0) return;
    const allowed: string[] = ['user-agent', 'support-calm', 'content-type', 'x-router',
      'kg-rc', 'kg-thash', 'kg-rec', 'kg-rf', 'dfid', 'mid', 'clienttime',
      // 汽水（qishui）：客户端令牌与「票据守卫」握手用的四个头。
      // bd-ticket-guard-client-csr 只在换取 ticket 时出现一次，其余三个是每次带身份请求都要的。
      'access-token', 'bd-ticket-guard-version', 'bd-ticket-guard-client-data',
      'bd-ticket-guard-client-cert', 'bd-ticket-guard-client-csr', 'bd-ticket-guard-server-data'];
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, string>;
    } catch (error) {
      ShellLog.warn(`proxy headers ignored (malformed json)`);
      return;
    }
    const names = Object.keys(parsed);
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const lower = name.toLowerCase();
      if (allowed.indexOf(lower) < 0) continue;
      headers[lower] = String(parsed[name]);
    }
  }

  /** headers 里有没有这个头（名字忽略大小写）。 */
  private static hasHeader(headers: Record<string, string>, name: string): boolean {
    const names = Object.keys(headers);
    for (let index = 0; index < names.length; index++) {
      if (names[index].toLowerCase() === name) return true;
    }
    return false;
  }

  /** 真正发一次请求（GET / POST 共用）。 */
  private static async perform(
    target: string, headers: Record<string, string>, body: string, isPost: boolean,
  ): Promise<ProxyResult> {
    const client = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: isPost ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: headers,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
        usingCache: false,
      };
      if (isPost) {
        options.extraData = body;
      }
      const response = await client.request(target, options);
      const contentType = HttpProxy.headerOf(response.header, 'content-type');
      const bytes = new Uint8Array(response.result as ArrayBuffer);
      return {
        status: response.responseCode,
        mime: HttpProxy.mimeOf(contentType),
        charset: HttpProxy.charsetOf(contentType) ?? '',
        body: new util.Base64Helper().encodeToStringSync(bytes),
        headers: HttpProxy.headersToJson(response.header as Object),
      };
    } catch (error) {
      const failure = error as BusinessError;
      ShellLog.error(`proxy failed: ${target} code=${failure.code} msg=${failure.message}`);
      return HttpProxy.jsonResult(502, '{"error":"Proxy request failed"}');
    } finally {
      client.destroy();
    }
  }

  private static isAllowedLyricHost(host: string): boolean {
    return host === 'qq.com' || host.endsWith('.qq.com')
      || host === 'y.gtimg.cn'
      || host === 'kugou.com' || host.endsWith('.kugou.com')
      // 网易音频 CDN：签名地址不带 CORS 头，页面里的 <audio> 只能经由同源代理取字节。
      || host === 'music.126.net' || host.endsWith('.music.126.net')
      || host === 'music.127.net' || host.endsWith('.music.127.net')
      // 汽水音乐：接口在 open.qishui.com / open.douyin.com / open-client.douyin.com（不带 CORS 头），
      // 场景封面在 douyinpic.com。音频 CDN（365yg.com 等）不走这里——真机实测 <audio> 能直接播，
      // 交给媒体栈自己取，省一次中继。
      || host === 'qishui.com' || host.endsWith('.qishui.com')
      || host === 'douyin.com' || host.endsWith('.douyin.com')
      || host === 'douyinpic.com' || host.endsWith('.douyinpic.com');
  }

  // ---- /api/netease-proxy ------------------------------------------------------------

  /**
   * 网易云的**哑管道**：加密、路由、Cookie 记账全在 web 层（`neteaseEapiTransport.ts`），
   * 壳只负责把上游那个 POST 原样重放一次，再把状态、Set-Cookie、响应体装进信封回去。
   *
   * 调用方送来的 query：
   *   url=<上游绝对地址>  method=POST|GET  body=<表单串>  cookie=<k=v; k=v>  ua=<UA>  referer=<可选>
   */
  private static async netease(url: string): Promise<ProxyResult> {
    const target = HttpProxy.queryParam(url, 'url');
    if (target === null || target.length === 0) {
      return HttpProxy.envelope(400, '', '{"code":400,"msg":"Missing url parameter"}');
    }

    const parsed = HttpProxy.parseUrl(target);
    if (parsed === null) {
      return HttpProxy.envelope(400, '', '{"code":400,"msg":"Malformed url parameter"}');
    }
    if (parsed.scheme.toLowerCase() !== 'https') {
      return HttpProxy.envelope(403, '', '{"code":403,"msg":"Forbidden: https only"}');
    }
    if (!HttpProxy.isAllowedNeteaseHost(parsed.host.toLowerCase())) {
      return HttpProxy.envelope(403, '', '{"code":403,"msg":"Forbidden: domain not allowed"}');
    }

    // 断网：系统栈和中继都要等超时，直接回网络失败（页面按 network 处理，并交给断网重连）。
    if (!NetworkMonitor.isOnline()) {
      ShellLog.info(`netease skipped (offline): ${target}`);
      return HttpProxy.offlineEnvelope();
    }

    const method = (HttpProxy.queryParam(url, 'method') ?? 'POST').toUpperCase();
    if (method !== 'POST' && method !== 'GET') {
      return HttpProxy.envelope(400, '', '{"code":400,"msg":"Unsupported method"}');
    }
    const formBody = HttpProxy.queryParam(url, 'body') ?? '';
    const cookie = HttpProxy.queryParam(url, 'cookie') ?? '';
    const referer = HttpProxy.queryParam(url, 'referer') ?? '';
    const userAgent = HttpProxy.queryParam(url, 'ua') ?? '';

    // 请求头逐字对齐一个**实测能过网易风控**的客户端（参考实现在电脑上用 axios 发的那一套）。
    // 之前只发 UA/Cookie/Referer 三件套时，扫码登录在最后一步被 `8821 环境风险` 打回。
    const headers: Record<string, string> = {};
    headers['Accept-Encoding'] = 'gzip, deflate, br';
    headers['Accept'] = 'application/json, text/plain, */*';
    if (cookie.length > 0) {
      headers['Cookie'] = cookie;
    }
    if (referer.length > 0) {
      headers['Referer'] = referer;
    }
    headers['User-Agent'] = userAgent.length > 0 ? userAgent : NETEASE_DEFAULT_UA;
    if (method === 'POST' && formBody.length > 0) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const options: http.HttpRequestOptions = {
      method: method === 'GET' ? http.RequestMethod.GET : http.RequestMethod.POST,
      header: headers,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
      usingCache: false,
      // HTTP/1.1 打头：实测能过网易风控的那个客户端（axios）走的就是 1.1，
      // 顺带避开上游 HTTP/2 连接偶发被 peer 掐断的问题。
      usingProtocol: http.HttpProtocol.HTTP1_1,
    };
    if (method === 'POST' && formBody.length > 0) {
      options.extraData = formBody;
    }

    // 复用同一条 keep-alive 连接：扫码时每 2 秒轮询一次，每跳都新建 TLS 连接是浏览器绝不会有的
    // 行为，而这类“连接行为”正是风控评分项之一。池里只有一个实例，并发时临时新建、用完销毁。
    // 先走「页面里发」这条通道：真 Chromium、同源、cookie 由浏览器自己带 —— 服务端认的正是这个客户端。
    // 系统网络栈发同样的东西会被当成未登录（见 WebNeteaseBridge 的文件头）。
    // 只转 Content-Type：Cookie/User-Agent/Referer 在 fetch 里禁止由脚本设置，页面自己的会话更权威。
    //
    // 这里**不再先问 `isReady()`**：中继页会长时间停在 `readyState: 'interactive'` 而不触发 onPageEnd，
    // 于是 ready 一直 false，而它其实完全可用。结果就是所有请求都退回系统网络栈、被当成未登录
    // （日志里 musicU=0 / account:null / 歌曲地址 code -110），表现成「明明登录过，突然全都没登录」。
    // 现在由 request() 自己做源探测：能注入且 origin 对就当场转正。
    {
      const relayHeaders: Record<string, string> = {};
      if (method === 'POST' && formBody.length > 0) {
        relayHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const relayed = await WebNeteaseBridge.request(target, method, relayHeaders, formBody);
      if (relayed.outcome === 'ok') {
        ShellLog.info(`netease relay: ${method} ${target} -> ${relayed.status} bytes=${relayed.body.length} body=${ShellLog.preview(relayed.body, 200)}`);
        // 扫码确认成功那一步，Set-Cookie 落在浏览器罐里，壳看不到响应头 ——
        // 读出来塞进信封，页面照旧按 `cookie` 字段落盘，登录态就同步过去了。
        // 只在这一条路由上做：别的响应体里随便出现个 803 不该触发一次 cookie 读取。
        let harvested = '';
        if (target.indexOf('login/qrcode/client/login') >= 0 && relayed.body.indexOf('803') >= 0) {
          harvested = await WebNeteaseBridge.harvestCookie();
          ShellLog.info(`netease relay: session cookie harvested len=${harvested.length}`);
        }
        return HttpProxy.envelope(relayed.status, harvested, relayed.body);
      }
      if (relayed.outcome === 'network') {
        // 请求发出去了但没拿到响应：**不能**退回系统网络栈。那条路会被网易当成另一个客户端，
        // 回 `account:null`，把断网变成「登录失效」（真机日志里就是这么丢掉登录态的）。
        ShellLog.warn(`netease relay network failure, not falling back: ${target}`);
        return HttpProxy.offlineEnvelope();
      }
      ShellLog.warn('netease relay unavailable, falling back to system stack');
    }

    const client: http.HttpRequest = HttpProxy.takeNeteaseClient();
    // musicU / csrf 打出来是为了区分两种完全不同的失败：
    //   musicU=0 → cookie 根本没被带上去（壳的 header 被丢了）
    //   musicU=1 但服务端仍回未登录 → 服务端按客户端指纹不给会话（和 8821 同一件事）
    ShellLog.info(`netease: ${method} ${target} body=${formBody.length} cookie=${cookie.length} musicU=${cookie.indexOf('MUSIC_U') >= 0 ? 1 : 0} csrf=${cookie.indexOf('__csrf') >= 0 ? 1 : 0}`);

    // 三轮重试覆盖实测遇到的全部失败形态：解不出 JSON（压缩/空体）→ 退回 identity；
    // 传输层异常（如 2300056 "Failed to receive data from the peer"）→ 换 HTTP/2 再发。
    const plans: NeteasePlan[] = [
      { protocol: http.HttpProtocol.HTTP1_1, encoding: 'gzip, deflate, br' },
      { protocol: http.HttpProtocol.HTTP1_1, encoding: 'identity' },
      { protocol: http.HttpProtocol.HTTP2, encoding: 'identity' },
    ];
    let response: http.HttpResponse | null = null;
    for (let attempt = 0; attempt < plans.length; attempt += 1) {
      options.usingProtocol = plans[attempt].protocol;
      headers['Accept-Encoding'] = plans[attempt].encoding;
      options.header = headers;
      try {
        const candidate = await client.request(target, options);
        if (HttpProxy.isReadableBody(candidate)) {
          response = candidate;
          break;
        }
        ShellLog.warn(`netease attempt ${attempt + 1}: body not readable encoding=${headers['Accept-Encoding']}`);
      } catch (error) {
        const failure = error as BusinessError;
        ShellLog.warn(`netease attempt ${attempt + 1} failed: ${target} code=${failure.code} msg=${failure.message}`);
      }
    }

    if (response === null) {
      // 这条连接已经不可信，别再还回池子。
      client.destroy();
      return HttpProxy.envelope(502, '', '{"code":502,"msg":"upstream unreachable"}');
    }
    HttpProxy.giveBackNeteaseClient(client);
    const text = typeof response.result === 'string' ? response.result as string : '';
    const setCookie = HttpProxy.headerOf(response.header, 'set-cookie');
    ShellLog.info(`netease done: ${response.responseCode} bytes=${text.length} setCookie=${setCookie.length} body=${ShellLog.preview(text, 240)}`);
    return HttpProxy.envelope(response.responseCode, HttpProxy.cookiesOf(setCookie), text);
  }

  /** 壳给页面的响应一律是 JSON 信封，所以“可读”就等于“非空且以 `{`/`[` 开头”。 */
  private static isReadableBody(response: http.HttpResponse): boolean {
    const text = typeof response.result === 'string' ? response.result as string : '';
    const trimmed = text.trimStart();
    if (trimmed.length === 0) {
      return false;
    }
    const first = trimmed.charAt(0);
    return first === '{' || first === '[';
  }

  private static takeNeteaseClient(): http.HttpRequest {
    const pooled = HttpProxy.idleNeteaseClient;
    HttpProxy.idleNeteaseClient = null;
    return pooled !== null ? pooled : http.createHttp();
  }

  private static giveBackNeteaseClient(client: http.HttpRequest): void {
    if (HttpProxy.idleNeteaseClient === null) {
      HttpProxy.idleNeteaseClient = client;
    } else {
      client.destroy();
    }
  }


  private static isAllowedNeteaseHost(host: string): boolean {
    return host === 'music.163.com' || host.endsWith('.music.163.com');
  }

  // ---- 结果构造 -----------------------------------------------------------------------

  /** 网易信封：真实状态在 body 里，Set-Cookie 拉平放在 cookie 里。 */
  private static envelope(status: number, cookie: string, body: string): ProxyResult {
    const payload: ProxyEnvelope = { status: status, cookie: cookie, body: body };
    return HttpProxy.textResult(200, 'application/json', JSON.stringify(payload));
  }

  /**
   * 网络层失败的信封。
   *
   * 文案用 `ENETUNREACH` 是故意的：页面按 `shared/networkErrorText.mjs` 的规则认网络错误，
   * 识别不到就会被归成「证据不足」，既不会自动重试也不会走断网重连。
   */
  private static offlineEnvelope(): ProxyResult {
    return HttpProxy.envelope(502, '', '{"code":502,"msg":"ENETUNREACH: network is unreachable"}');
  }

  /** 与部署端函数同形状的错误体，页面的失败处理因此是同一套。 */
  private static jsonResult(status: number, text: string): ProxyResult {
    return HttpProxy.textResult(status, 'application/json', text);
  }

  private static textResult(status: number, mime: string, text: string): ProxyResult {
    return {
      status: status,
      mime: mime,
      charset: 'utf-8',
      body: new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(text)),
      headers: '{}',
    };
  }

  /** 这些响应头不进透传表：长度与编码要按**实际拿到的 body** 重建，转述上游的只会让页面解析出错。 */
  private static readonly RESPONSE_HEADER_SKIP: string[] = ['content-length', 'content-encoding',
    'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'];

  /** 把上游响应头收成一行 JSON，交给页面。set-cookie 单独走信封的 cookie 字段（网易），这里不重复。 */
  private static headersToJson(header: Object): string {
    if (header === null || header === undefined) return '{}';
    const table = header as Record<string, string>;
    const picked: Record<string, string> = {};
    const names = Object.keys(table);
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (HttpProxy.RESPONSE_HEADER_SKIP.indexOf(name.toLowerCase()) >= 0) continue;
      picked[name] = String(table[name]);
    }
    return JSON.stringify(picked);
  }

  // ---- 小工具 -------------------------------------------------------------------------

  /** `https://host/path?q#f` → `path`。用来做精确匹配，避免前缀匹配顺手吃掉别的路径。 */
  private static pathOf(url: string): string {
    const schemeEnd = url.indexOf('://');
    const rest = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
    const slash = rest.indexOf('/');
    let path = slash >= 0 ? rest.slice(slash) : '/';
    const query = path.indexOf('?');
    if (query >= 0) {
      path = path.slice(0, query);
    }
    const hash = path.indexOf('#');
    if (hash >= 0) {
      path = path.slice(0, hash);
    }
    return path;
  }

  /**
   * 取一个 query 参数并百分号解码。
   *
   * 必须解码：页面用 `encodeURIComponent` 塞进来的是整个上游地址（`https%3A%2F%2F...`），
   * 不解码就拼不出一个能用的 URL。安卓那边由 `Uri.getQueryParameter` 代劳了。
   */
  private static queryParam(url: string, key: string): string | null {
    const queryStart = url.indexOf('?');
    if (queryStart < 0) {
      return null;
    }
    const hash = url.indexOf('#', queryStart);
    const query = hash >= 0 ? url.slice(queryStart + 1, hash) : url.slice(queryStart + 1);
    for (const pair of query.split('&')) {
      const equals = pair.indexOf('=');
      if (equals <= 0) {
        continue;
      }
      if (pair.slice(0, equals) !== key) {
        continue;
      }
      const raw = pair.slice(equals + 1);
      try {
        return decodeURIComponent(raw);
      } catch (malformed) {
        return raw;
      }
    }
    return null;
  }

  private static parseUrl(target: string): UrlParts | null {
    const schemeEnd = target.indexOf('://');
    if (schemeEnd <= 0) {
      return null;
    }
    const scheme = target.slice(0, schemeEnd);
    const rest = target.slice(schemeEnd + 3);
    const slash = rest.indexOf('/');
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    if (authority.length === 0) {
      return null;
    }
    // 去掉 userinfo 与端口：白名单只看主机名。
    const at = authority.lastIndexOf('@');
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = hostPort.indexOf(':');
    const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    if (host.length === 0) {
      return null;
    }
    return { scheme: scheme, host: host };
  }

  /**
   * `response.header` 的键大小写不保证（鸿蒙 http 给的是 `Content-Type`，不是全小写），
   * 所以逐键小写比较。写死两个候选拼法会漏掉真实的那一种：歌词/封面会因为 mime 变成
   * octet-stream 而整片失效，且不报错。
   */
  private static headerOf(header: Object, name: string): string {
    if (header === null || header === undefined) {
      return '';
    }
    const table = header as Record<string, string>;
    const wanted = name.toLowerCase();
    for (const key of Object.keys(table)) {
      if (key.toLowerCase() !== wanted) {
        continue;
      }
      const value = table[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return '';
  }

  /**
   * 把 `Set-Cookie` 拉平成 `k=v; k=v`（属性全丢，页面只留 name/value）。
   *
   * 鸿蒙 http 把多条 Set-Cookie 可能以 `, ` 或 `; ` 拼接，两种都要能吃下；删除（空值）保留成
   * `k=`，否则页面删不掉旧 cookie，登出不会生效。`Expires` 里的逗号会切出没有 `=` 的碎片，
   * 直接跳过即可。
   */
  private static cookiesOf(setCookie: string): string {
    if (setCookie.length === 0) {
      return '';
    }
    const parts: string[] = [];
    for (const raw of setCookie.split(/[;,\n]/)) {
      const piece = raw.trim();
      const equals = piece.indexOf('=');
      if (equals <= 0) {
        continue;
      }
      const name = piece.slice(0, equals).trim();
      if (name.length === 0 || HttpProxy.COOKIE_ATTRIBUTES.indexOf(name.toLowerCase()) >= 0) {
        continue;
      }
      const value = piece.slice(equals + 1).trim();
      parts.push(value.length === 0 ? `${name}=` : `${name}=${value}`);
    }
    return parts.join('; ');
  }

  private static mimeOf(contentType: string): string {
    const semicolon = contentType.indexOf(';');
    const mime = (semicolon >= 0 ? contentType.slice(0, semicolon) : contentType).trim();
    return mime.length > 0 ? mime : 'application/octet-stream';
  }

  private static charsetOf(contentType: string): string | null {
    const index = contentType.toLowerCase().indexOf('charset=');
    if (index < 0) {
      return null;
    }
    const charset = contentType.slice(index + 8).split(';')[0].trim().replace(/"/g, '');
    return charset.length > 0 ? charset : null;
  }

  /** Set-Cookie 里的属性名（不是 cookie 本身），拉平时要丢掉。 */
  private static readonly COOKIE_ATTRIBUTES: string[] = [
    'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'version',
    'comment', 'priority', 'partitioned',
  ];
}

/** URL 里白名单要用的两个部分。 */
interface UrlParts {
  scheme: string;
  host: string;
}
