# Folia Mobile

把 [Folia](https://github.com/chthollyphile/folia-major) 带到手机上的非官方移植。

- **Android**：一个自带 Web 产物的壳（WebView），所以离线是结构性的而不是"尽力而为"。
- **iOS**：目前**没有**可用版本。可行形态只有两种，都还没做：纯 PWA（Safari 不支持 Screen Orientation API 的横屏锁定，且在线音源需要自部署实例），或一个 WKWebView 壳（能做到锁横屏和自带代理，但要 Mac + Apple 开发者账号）。iOS 这条路在真正开工前不承诺任何东西——为什么现在冻结、什么条件下会重新打开，写在 [`docs/ios-port.md`](docs/ios-port.md)。
- 定位：**锁横屏的音乐观赏播放器**。

> 本项目与上游 Folia 作者无隶属关系，是一个社区移植。

## 下载

到 [Releases](../../releases) 下载 APK。

> ⚠️ **验证状态（请如实看待）**
>
> - **v0.3.0 已在真机上确认可用：能检测到手机里的音乐，也能正常出声播放。**流式播放这条链路（含原生 Range 支持）是实测通过的。
> - **v0.2.0 已在真机上确认可以启动**，但它的**手动导入本地音乐没有成功**：本地页签停在「未检测到任何本地音乐」。这条路径目前不可信，原因仍在排查——设备音乐库不经过它。
> - **v0.3.1 的网易设置项尚未在真机上验证过**（它只是新增一个设置输入框与命令面板条目，不改变既有播放路径）。
> - **v0.4.0 的三项改动尚未在真机上验证过**：画布像素倍率封顶、首启默认 60 帧、帧率 HUD。前两项只改渲染参数，第三项是一个可关闭的浮层，都不动播放链路。
> - **v0.5.0 的网易云内置实现尚未在真机上验证过**。它走通了整条链路（加密、路由、扫码、播放地址）的单测，但**网易的风控只有真机能回答**——扫码能不能出图、登录态能不能保持、播放地址会不会被拒，都还没有一次实测。酷狗的播放链路不受影响（两者互不依赖）。
> - **v0.6.0 的性能改动有一半是量出来的、一半还没有对比读数**。帧率读数是真机读数（隐现背景下可视化器 `p50 33.3ms`，墙面 `59.5fps / p50 11.1ms`），据此把歌词发光改到合成层；但**改完之后的那次 A/B 对比还没做**——同一首歌、同一位置，`背景 = 隐现` 与 `背景 = 通用` 各读一次 fps，才能给这些改动记分。
> - v0.3.0 以来**封面仍未接通**：设备音乐库里的歌显示占位图。
> - **本仓库没有可用的 adb 通道**：目标机型跑 HarmonyOS，它的 USB 调试功能是 HDC（厂商接口 `ff/50`），不是 adb 认的 `ff/42`，无线调试也没有配对入口。`dumpsys gfxinfo` 在这台设备上取不到，性能数据只能靠 v0.4.0 新增的应用内帧率 HUD 读。
>
> 装上后如果有问题，欢迎开 issue；能连 adb 的设备（非 HarmonyOS）可以附上 `adb logcat -s FoliaShell` 的输出。

系统要求：Android 8.0+（minSdk 26）。

## 现在能用什么、不能用什么

**已完成**

- 壳：用 `WebViewAssetLoader` 把 APK 内的 Web 产物挂在虚拟 https 源上（`appassets.androidplatform.net`）——页面因此仍是 secure context，IndexedDB / OPFS / Cache Storage 全部可用，这也是离线能成立的原因。
- 沉浸式全屏、锁横屏，以及**竖屏兜底**（系统方向锁可以压过应用的横屏请求，所以竖屏时给一张可读的提示层）。
- 文件选择（含多选，WebView 的 `ClipData` 陷阱已处理）。
- 前台媒体服务 + MediaSession + 通知卡片（**原生侧刻意不申请音频焦点**，见下）。
- **本地音乐导入**：不依赖 `showDirectoryPicker`，安卓与 iOS 的浏览器都能用；导入的音频字节写入 OPFS，播放时无需文件句柄。
- **设备音乐库（v0.3.0）**：直接读取手机自己的音乐收藏（MediaStore），**打开应用就能看到歌**，不需要手动挑文件。见下节。
- **在线音源（酷狗）**：搜索、播放、歌词、封面，**不需要任何服务器**（见下节）。
- **网易云 API 地址（v0.3.1）**：可在应用内填写自部署实例的地址，改完立即生效、无需重新打包（见下节）。
- **网易云内置实现（v0.5.0）**：手机壳自己实现了 eapi/weapi 加密与十余条路由，**扫码登录 + 搜索 + 播放 + 歌词不需要部署任何东西**（见下节）。
- **性能（v0.4.0）**：画布后备缓冲的像素倍率封顶到 2 倍（3 倍屏从 9 倍像素量降到 4 倍）；手机壳首启默认把 rAF 限到 60 帧（图形设置里可改回 90/120 或关闭）；新增**应用内帧率 HUD**——长按屏幕左上角 0.8 秒开关，显示 p50/p90/p99、jank 比例、长任务与堆占用。
- **性能（v0.6.0）**：歌词发光在 Android 上改由合成层滤镜绘制（模糊按图层缓存，不再每帧重新光栅化每个发光字的阴影遮罩）；隐现背景的 mesh 着色器在手机上降到 640×360（少 75% 的像素，dithering 那层保持原分辨率，因为它的 4×4 图案按设备像素画、一掉分辨率就出摩尔纹）；帧率 HUD 的 `jank` 改成相对本次会话中位数的判据，长任务与帧样本来自同一个窗口，并会标出**长任务开始时应用在做什么**（`block lyric line 83 ms`、`block song change 591 ms`）。
- **思索按钮可拖动（v0.6.0）**：触屏上那颗右键入口（灯泡）默认还在右上角，但按住就能拖到任何位置，松手即记住；叫出它的热区跟着按钮走，拖动不会顺手打开思索。

**未完成**

- 设备音乐库的**封面**尚未接通：这些歌会显示占位图，而不是专辑封面。原生侧的取图端点已经写好，缺的是 Web 侧把它接进曲库封面仓。
- 设备音乐库的**内嵌歌词 / ReplayGain** 不参与：MediaStore 只提供标题、歌手、专辑、时长这类字段，读取文件内嵌内容需要把整首歌拉进内存，与"流式播放"的前提冲突。
- 后台播放的 Web 侧快照推送钩子未接，所以媒体通知目前收不到数据（服务已就绪）。
- SAF 整目录导入、`audio/*` 唤起、应用自更新：接口名已预留但**故意不注册空方法**，以保证页面的逐方法能力探测是诚实的。

## 设备音乐库

v0.3.0 起，应用会读取手机自身的音乐收藏，并把这些歌**当成普通本地歌曲**放进曲库——文件夹 / 专辑 / 歌手分组、歌词匹配、歌单、播放器全都不需要知道它们从哪来。

工作方式：

1. 应用启动时检查 `READ_MEDIA_AUDIO` 权限（Android 13+；更低版本用 `READ_EXTERNAL_STORAGE`），**只询问一次**。
2. 壳通过 MediaStore 列出收藏（`IS_MUSIC` 过滤，并排除 10 秒以下的提示音）。
3. 这些歌被并入本地曲库，归在「手机音乐」文件夹下。
4. 播放时音频从**原始 `content://` 位置流式读取**，不是复制。

几个刻意的取舍：

- **不复制任何音频**：几千首歌不占额外空间、不占 OPFS 配额、没有导入等待。只读，从不写入 MediaStore，卸载应用不会影响你的音乐。
- **不申请音频焦点**（与壳的既有约束一致，见下）。
- **重新同步不会丢你的编辑**：已经存在的歌只刷新 MediaStore 自己那几个字段，你匹配过的歌词、标记过的纯音乐、选过的歌词来源都保留。
- **一次"读取成功但列表为空"会被拒绝**，当成 MediaStore 还在扫描，而不是"用户把音乐全删了"——删除是这里唯一有破坏性的动作。
- 本地页签的**刷新**按钮同时也是"重新扫描手机音乐"：它会在你刚点的这一下里重新读取列表，需要权限时也在这里弹窗。

> 首次进入请切到**本地**页签（应用默认停在在线页签）。

## 在线音源

桌面版把网易云 / QQ / 酷狗的 API 后端**内置在主进程里**，所以它天生就能在线听。Web 与壳形态没有这些后端——但**酷狗有一条不需要任何服务器的公开路径**，网易云在 v0.5.0 里也被搬进了壳，两条都接通了：

| 能力 | 状态 |
|---|---|
| 搜索 | ✅ 可用（酷狗的匿名签名搜索，签名在网页层计算） |
| 播放 | ✅ **约六成曲目可播**；付费曲目会明确提示需要账号，而不是报"网络错误" |
| 歌词 | ✅ 可用 |
| 封面 | ✅ 可用 |
| 网易云（v0.5.0） | ✅ **扫码登录后可用**，不需要部署实例。会员曲目仍受版权限制 |
| 网易云（自部署实例） | ⚠️ 仍然支持：在「设置 → 集成 → 网易云 API 地址」里填地址即可接管 |
| QQ | ⚠️ **需要你自己部署一个 API 实例**，然后在「设置 → 集成 → 网易云 API 地址」里填地址（v0.3.1 起可在应用内直接填，不用重新打包）。见下节 |
| 波点音乐 | ❌ 桌面独占（依赖主进程里的 Node 包，网页版无法运行） |

**首次使用请先切到「酷狗」或「网易云」**：应用默认的活动音源是网易云，v0.5.0 起在手机上可用（要扫码登录）；不想登录就切到酷狗，它的匿名路径能播约六成曲目。

为什么酷狗能免服务器：网页层自己实现了酷狗的匿名签名，缺的只是"谁来发这个请求"——浏览器直连拿不到 CORS 头。壳内有一个原生的 `/api/lyric-proxy`（与部署形态下 `api-ts/lyric-proxy.ts` 这个 serverless 函数同一份契约），由它负责发请求。页面因此只与自己的源通信，既不涉及 CORS，也不涉及混合内容。

为什么只有约六成曲目能播：酷狗的公开播放端点对头部版权内容返回"需要付费"且不给任何链接。实测 180 首去重曲目中，约 71 首属于这一类。这不是缺陷，是版权策略——壳会把它如实报成"需要付费"，不会假装是网络故障。

## 网易云

网易和酷狗的处境完全不同，这一节是实测结论（2026-10，匿名直连 `music.163.com`）：

| 请求 | 匿名结果 |
|---|---|
| `POST /api/search/get/web` | ✅ 200，完整搜索结果（只要 `Referer` + UA，无签名无 Cookie） |
| `GET /api/song/lyric` | ✅ 200，完整 LRC + 译文 |
| `POST /weapi/song/enhance/player/url/v1` | ❌ 200 但 `url: null, code: 404` |
| `POST /weapi/cloudsearch/pc` | ❌ `code:500 请求失败` |

**也就是说：网易不登录就不给音频地址。** 这跟酷狗匿名就能拿到约六成曲目完全不同，所以「像酷狗那样在网页层匿名直连」这条路对网易走不通。

桌面版之所以能用，是因为它把 `@neteasecloudmusicapienhanced/api` 这个 **449 个路由模块的 Node 服务**跑在了 Electron 主进程里。浏览器和 WebView 跑不了它（依赖 `fs`/`crypto`/`http`、`anonymous_token`、xeapi 公钥与设备注册）。但那份服务干的活其实只有两件：把路径翻译成上游端点，以及做 eapi/weapi 加密。这两件都能在 Web 侧重做。

### v0.5.0：手机壳自己做了这两件事，不需要任何实例

上表那些「匿名不给」的结论测的是**网页层直接 fetch 网易域名**——那被 CORS 挡着。v0.5.0 换了做法：壳里加了一个**限定域名的 POST 转发器**，加密、路由、cookie jar 全在 Web 侧。于是手机端现在是**开箱扫码登录就能在线听网易**，不用部署任何东西。

已实现的路由，响应形态与实例逐条对齐：

| 能力 | 路由 |
|---|---|
| 扫码登录三步 | `/login/qr/key`、`/login/qr/create`（二维码本地画，不联网）、`/login/qr/check` |
| 登录态 | `/login/status`、`/user/account`、`/logout` |
| 搜索 | `/cloudsearch` |
| 播放与歌词 | `/song/url/v1`、`/lyric/new`、`/song/chorus` |
| 曲库 | `/user/playlist`、`/playlist/detail`、`/playlist/track/all`、`/likelist`、`/like` |
| 推荐 | `/recommend/songs`、`/personal_fm` |
| 游客态 | `/register/anonimous` |

**没实现**的路由（歌手/专辑详情、云盘等）返回实例同形的 `{code:404,msg:"Not Found"}`，走原有的「这条路由不支持」降级，不会假装成功。尤其是 `/scrobble/v1` 听歌打卡：它需要一套 NCBL 日志上传，这里没编，也**不会**返回 200 假装记了一次播放。

两点必须诚实说明：

- **风控未验证**。参考包里除了 eapi/weapi，还躺着 xeapi（X25519 + AES-GCM）和 neapi（chacha20-poly1305 + zstd），说明网易在往上加固。这里选 eapi/weapi 是因为端点模块自己还在用它们；如果真机被拦（返回空、code 报错、要验证码），正确的做法是评估换 xeapi，而不是在现有代码里硬凑。
- **会员曲目仍受版权限制**。播放地址依赖登录态，非会员遇到 VIP 曲目照样是 `url: null`，壳会如实报出来。
- **游客凭证失败后十分钟内不重试**。没登录时每个请求前会先换一张游客 token；如果这一步一直被拒，逐请求重试就等于把一次搜索变成两个请求。这里用持久化的时间窗口兜住，刷新页面也不会重新锤一遍。

### 另一条路：部署一个实例，然后在应用里填地址

v0.3.1 起，「设置 → 集成 → 网易云 API 地址」可以直接填，**改完立刻生效，不用重新打包**（上游原本只有构建期变量 `VITE_NETEASE_API_BASE`，对已经装在手机上的 APK 没有意义）。

几点实测与提醒：

- **用 https 的实例**。请部署**独立的网易 API 实例**（Vercel / Cloudflare Workers 的免费额度够用，或自己的 Docker 加 TLS 反代）。安卓壳只对音源域名开了明文白名单，`http://` 的局域网地址会被系统策略拦掉。
- **不要直接填 Folia Docker 全栈的 `/netease/` 路由**。那个 gateway 段（`deploy/docker/gateway/nginx.conf.template` 的 `location /netease/`）**不加 CORS 头**——它服务的是同源的 Web 页面，用不上。安卓壳是**跨源**调用，会被浏览器拒收。要复用它就得在该 location 里补上 CORS 头，并解决明文限制。
- **独立实例的 CORS 是自带的，实测可用**：Express 中间件会**回显 Origin**（不是 `*`）并带 `Access-Control-Allow-Credentials: true`。这一点很关键——应用的请求带 `credentials: 'include'`，如果服务端回 `*`，浏览器会直接拒收，而回显 Origin 就没问题。
- **填了地址就以地址为准**：v0.5.0 的内置实现只在**没填地址**时生效。填了实例地址就是明确要用那个后端（比如想要 unblock 或内置实现还没做的路由），不会被内置实现悄悄顶掉。
- **登录态是客户端持有的**：会话 Cookie 每次请求作为 `cookie` 查询参数带过去（`src/services/netease.ts`），服务端不存会话。**因此无服务器部署（Vercel / Cloudflare）是可行的**，不需要一台常驻机器。
- 地址填错时输入框会变红并保留上一次可用的值，不会被写坏；旁边的「测试」按钮会发一个真实的搜索请求，能直接区分「地址写错」「实例没起来」「CORS 没放行」。

## 构建

前置：**Node 24**、**JDK 17**、**Android SDK 35**（含 build-tools 35.0.0 与 platform-tools）。

### 1. Web 产物

```bash
cd web
export ELECTRON_SKIP_BINARY_DOWNLOAD=1   # 桌面二进制对本项目无用，跳过约 100MB 下载
npm install
npm run build                            # 产出 web/dist
```

### 2. APK

```bash
cd android
# 告诉 Gradle 你的 SDK 在哪
echo "sdk.dir=/absolute/path/to/android-sdk" > local.properties
./gradlew assembleDebug                  # 或用系统 gradle
```

壳会自动把 `web/dist` 镜像进 `app/src/main/assets/www/`（见 `android/tools/sync-web-assets.ps1`）；若用手工流程，记得先同步再打包。

### 发布签名

`app/build.gradle` 会在 `android/keystore.properties` 存在时使用正式签名，不存在时**不会**退回调试密钥——发布一个可分发的包应当是一次有意识的动作。

```properties
storeFile=/absolute/path/to/your-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

> 密钥一旦发布就**不能再更换**：换密钥意味着所有已安装用户必须卸载重装并丢失数据。请把 `.jks` 与密码备份到仓库之外的安全位置。

## 我们对上游做了什么修改

上游源码完整保留在 `web/`，我们的改动以补丁形式放在 `patches/`，按顺序叠加上游 v0.7.20 即可复现：

```
patches/0001-feat-local-music-import-a-library-from-plain-File-ob.patch
patches/0002-feat-kugou-reach-KuGou-s-public-endpoints-without-a-.patch
patches/0003-feat-device-library-list-and-stream-the-phone-s-own-.patch
patches/0004-feat-netease-make-the-API-gateway-address-configurab.patch
patches/0005-perf-render-cap-canvas-backing-stores-at-2x-device-p.patch
patches/0006-perf-runtime-default-the-frame-rate-gate-to-60-on-th.patch
patches/0007-feat-debug-read-frame-timings-on-the-screen-because-.patch
patches/0008-feat-netease-port-the-eapi-and-weapi-request-ciphers.patch
patches/0009-feat-netease-answer-the-NetEase-API-routes-inside-th.patch
patches/0010-fix-mobile-keep-one-upcoming-lyric-line-and-let-the-.patch
patches/0011-fix-bravais-do-not-draw-the-seam-title-quotes-around.patch
patches/0012-fix-bravais-stop-the-seam-s-vertical-title-from-coll.patch
patches/0013-fix-bravais-horizontal-title-on-short-seams-perf-net.patch
patches/0014-perf-visualizer-draw-the-lyric-glow-on-the-composito.patch
patches/0015-perf-visualizer-cut-the-mesh-shader-s-pixel-budget-o.patch
patches/0016-perf-debug-split-a-long-frame-into-script-style-layo.patch
patches/0017-perf-debug-attribute-a-long-task-to-the-app-phase-it.patch
patches/0018-fix-debug-count-long-tasks-over-the-same-span-as-the.patch
patches/0019-fix-debug-measure-jank-against-the-session-s-own-fra.patch
patches/0020-feat-ponder-let-the-touch-button-be-dragged-and-reme.patch
patches/0021-test-ponder-cover-the-touch-button-s-drag-in-a-real-.patch
patches/0022-feat-debug-record-what-happens-when-the-screen-goes-.patch
patches/0023-fix-ponder-make-the-dragged-button-follow-the-finger.patch
```

- **0001 无句柄本地导入**：新增 OPFS 音频字节仓、`importLocalFiles(File[])` 与文件选择器入口、让 `FileEntryForImport.handle` 可选、三个播放访问器加字节仓回退、无句柄根目录不可重扫、以及让本地页签在只有文件导入可用时也可进入。
- **0002 酷狗免服务器路径**：传输层增加 `anonymous-public` 模式与能力声明，使音源在匿名模式下真正可选。
- **0003 设备音乐库**：新增 `deviceAudioLibrary` / `deviceAudioSync` 两个服务，`LocalSong` 增加 `deviceAudioId`，播放来源解析为流地址。
- **0004 网易 API 地址运行时可配置**：新增 `providerApiBase` 服务持有"哪个网关生效"，`netease.ts` 反向委托；集成设置新增输入项与连通性测试，并接入命令面板与三份 i18n。
- **0005 画布像素倍率封顶**：新增 `canvasPixelRatio` 把 `devicePixelRatio` 钳到 1..2，cadenza / monet / pendolo / fume 四处画布的后备缓冲与 `setTransform` 同步改用同一倍率。上游 `lumiere` 早有同样取舍（`LUMIERE_MAX_RENDER_RESOLUTION`），这里只是补齐遗漏的渲染器。
- **0006 手机壳首启默认 60 帧**：新增 `isAndroidShell`（看 `window.foliaAndroid` 是否存在，不看 UA）与 `ensureVisualizerFrameRateDefault`（只在存储里没有记录时播种，写进存储而不是只交给限帧器，保证图形设置与实际生效一致），启动期在装上限帧器之前调用。桌面与浏览器构建不受影响。
- **0007 应用内帧率 HUD**：新增 `frameSamples` 采样器（预分配环形缓冲、每帧零分配、不碰 React；采样走限帧器保存的原生 rAF，否则只会测到我们自己的上限；超过 250ms 的间隔不计入，那是切后台而非掉帧）与 `FrameStatsHud`（500ms 轮询，长按左上角开关，监听挂在 window 捕获阶段且不 `preventDefault`，不会抢走播放器的输入）。
- **0008 网易请求加密**：`neteaseCrypto` 移植 eapi（AES-128-ECB + MD5 摘要签名）与 weapi（双层 AES-CBC + 教科书式 RSA）。WebCrypto 没有 ECB，也没有无填充 RSA，所以 ECB 用单块零 IV CBC 拼出来，`encSecKey` 用 BigInt 做平方-乘。单测向量由参考实现生成后钉死，常量一漂就红。
- **0009 网易路由内置**：`neteaseDeviceProfile`（跨会话稳定的设备身份）、`neteaseEapiTransport`（请求组装与投递）、`neteaseLocalApi`（路由表 + cookie jar + 二维码本地生成 + 游客凭证十分钟重试窗口）、`neteaseQrImage`。`netease.ts` 的 `fetchWithCreds` 在 `isAndroidShell()` 且没有配置实例地址时走本地实现，桌面与网页版路径不变。壳侧新增 `NeteaseProxyHandler.java`。

- **0010 手机端两处界面修正**：字幕层的「下一句预览」在手机壳上只保留紧跟的一句并去掉椭圆底色（实测那块 298×122px 的区域正好是两行 + `-inset-x-10`/`-inset-y-6` 的光晕：它本来就已经贴着进度条上方，让它看着像悬在画面中间的是自身高度）；墙面工具面板从 `flex: none` + `overflow: hidden` 改成可收缩（120px 下界）+ 纵向滚动，矮视口下不再顶出屏幕上沿被裁掉。桌面构建维持原样。
- **0011 空标题不再画引号**：接缝的分隔线是「上引号 + 竖排标题 + 下引号」，标题为空时两个装饰引号就成了空带两端的两颗标点。改为一起收掉，并且那个空按钮不再进 Tab 序列与读屏。
- **0012 竖排标题不再被压成零**：`.bravais-seam-vtitle-wrap` 是 `flex: 1 1 auto` + `min-height: 0`，前面的 crumbs / 过滤 / 动作行分完高度后它可以被压到 0，再叠上 `max-height: 100%` 与父级 `overflow: hidden`，一个字都不剩。给 96px 下界并让盒子跟着文字走。
- **0013 矮接缝改横排标题 + 网易请求提速**：视口高度低于 480px 时标题单行横排加省略号、装饰引号不再绘制（18 个字的竖排标题在 300–340px 高的接缝里只能露出三四个字）。请求路径上：eapi 的 block 并行签发（30 块实测 0.658ms → 0.230ms，密文逐字节相同）、三个 AES 密钥只 import 一次并缓存、设备档案记忆化、cookie jar 只在真的变了才写回。
- **0014 歌词发光改由合成层绘制**：`glowBlurQuantize` 的平台默认从「仅 Linux」扩到 Linux + Android。手机关闭它时 classic 会在每一帧重新光栅化每个发光字的阴影遮罩（framer 连续插值 text-shadow 半径，Chromium 按阴影在设备空间的 sigma 分桶缓存字形），主线程空闲而帧丢在光栅化。视觉差异实测整体 0.06% 像素、最差 8×8 区域 1.06%。
- **0015 mesh 着色器的像素预算 + HUD 标出图层**：隐现背景的两层全屏着色器分开给预算——mesh 在 Android 上降到 640×360（23 万像素，比原来的 92 万少 75%），dithering 保持 1280×720（它按设备像素画 4×4 图案，掉分辨率就出摩尔纹）。HUD 增加 `vis` / `bg` / `glow` 三行，并新增 `isAndroidRuntime()`（壳或 Android UA），把「因为设备而降级」和「因为交付形态而降级」分开。
- **0016 长帧拆成 script / style / render**：`frameSamples` 同时观察 `long-animation-frame`，保留最慢那一帧的脚本时间、样式+布局时间、渲染时间、脚本内部强制布局的位置与最慢脚本名。归约是导出纯函数并有单测（entry 混用绝对标记与时长，结束点容易算错）。没有该 entry 的引擎上 HUD 降级成 `loaf: n/a` 而不是丢掉长任务。
- **0017 长任务归因到应用相位**：新增 `perfPhases` 环形记录（`beginPerfPhase` 在当前任务结束时闭合，所以 store 更新之后的 React 提交仍在相位内部）。长任务观察者按相位分组，HUD 显示最差的那一个。已标记的相位：换歌、换歌词行、隐现背景换调色板、墙面重新裁剪、封面取色。同时调色板取样改为先 `img.decode()` 再 `drawImage`（`onload` 只代表字节到了，解码发生在第一次 drawImage 里的主线程）。
- **0018 长任务与帧样本同一个窗口**：帧百分位来自最近 900 帧，长任务却从上次重置起一直累加，两个数字描述的是不同时段（于是「19 个长任务、最长 591ms」会和 1.2% 的卡顿率并排出现）。现在长任务带时间戳存在同一个窗口里，计数、最大值与相位归因都从同一段切片算。
- **0019 `jank` 用本次会话自己的帧时间做判据**：硬编码的 33.4ms（「漏两个 60Hz vsync」）在 90Hz 面板上会把「每三个 vsync 一帧」的齐整 33.3–33.5ms 判成 19% 卡顿。改为 `超过 max(33.4ms, 本窗口中位数 × 1.5)`，旧常数留作下界。同一补丁里，逐字发光在 `instant` / `fast` 展开模式下不再拆成每字一个 motion 节点（那两个变体在进入扫光分支前就返回，拆开只是让换行时多挂载一批节点）。
- **0020 思索按钮可拖动**：触屏上那颗浮动入口从 `right-5 top-5` 改成可拖动的视口坐标（`ponderTouchButtonPosition` 负责钳位与序列化），拖动过程只写 DOM style 与 ref、不经过 React state，松手才写 store；96px 的召唤热区跟着按钮走；拖动不会触发打开思索，按住期间 4 秒的自动收起计时器不会把按钮从手指下面抽走。

`web/` 的内容等于「上游 v0.7.20 + 这二十三个补丁」，可据此审计。

- **0023 拖动跟手**：位置从 `left`/`top` 改成 `translate3d`（前者每帧失效一次布局，而布局在主线程上；后者只挪一个已合成的图层），并给按钮加上 `touch-action: none`（否则浏览器会把拖动认成滚动平移、中途 `pointercancel` 掐断）与 `select-none`。`transition-all` 收窄成只过渡 `opacity`，按下缩放动画去掉（它与位置的 transform 抢同一个属性）。

- **0022 黑屏取证**：`services/debug/incidents.ts` 记未捕获异常、未处理的 Promise 拒绝、WebGL 上下文丢失与恢复，64 条环形缓冲 + 尾部持久化（被迫重载之后证据还在）。`installIncidentRecorders.ts` 在 `createRoot` 之前装监听；另有一个「#root 子节点掉到 0」的看门狗 —— 那正是没有错误边界的 React 树被卸载之后的状态。此时用**非 React 的纯 DOM** 显示最近几条错误和一个重载按钮（那种状态下 React 里已经没有东西能画）。帧率 HUD 增加 `gl` / `err` / `blank` 三行和 `reload` 按钮。注意：上下文丢失刻意**不** `preventDefault` —— 那等于向浏览器承诺一次本层重建不了的恢复。

- **0021 拖动链路的浏览器用例**：新增 `dev/probes/ponderTouchButton.probe.tsx` 与 `test/component/ponderTouchButton.spec.ts`。拖动只能靠真实指针事件验：坐标直接写到节点 style（每走一像素都不许经过 React）、6px 阈值区分「按下」和「拖」、松手那一下的 click 要被吃掉。顺带记下两条坑：组件项目的 Playwright 默认不开 `hasTouch`（按钮在细指针下直接返回 null），以及 harness 的 auto fixture 每次导航都会 `localStorage.clear()`，所以「重载后沿用」只能在单测里验。

## 为什么壳里绝不申请音频焦点

音频始终由 WebView 内的 Chromium 媒体栈播放。原生侧若再申请音频焦点会把它顶掉，页面收到 `AUDIOFOCUS_LOSS` 后立即自动暂停——表现为"一按播放就停"。壳的职责只有三件：把进程提到前台优先级、提供通知栏与锁屏传输控制、把系统事件（耳机拔出、语音搜索）翻译成给页面的命令。

## 许可

**AGPL-3.0**，与上游一致。`web/` 是上游 `chthollyphile/folia-major` v0.7.20 的完整源码（AGPL-3.0），壳代码以同一许可发布。详见 `NOTICE`。
