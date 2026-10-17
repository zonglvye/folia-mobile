# Folia Mobile

把 [Folia](https://github.com/chthollyphile/folia-major) 带到手机上的非官方移植。

- **Android**：一个自带 Web 产物的壳（WebView），所以离线是结构性的而不是"尽力而为"。
- **iOS**：纯 PWA（壳解决不了 iOS，且 iOS 上无法锁定横屏）。
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
- **性能（v0.4.0）**：画布后备缓冲的像素倍率封顶到 2 倍（3 倍屏从 9 倍像素量降到 4 倍）；手机壳首启默认把 rAF 限到 60 帧（图形设置里可改回 90/120 或关闭）；新增**应用内帧率 HUD**——长按屏幕左上角 0.8 秒开关，显示 p50/p90/p99、jank 比例、长任务与堆占用。

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

桌面版把网易云 / QQ / 酷狗的 API 后端**内置在主进程里**，所以它天生就能在线听。Web 与壳形态没有这些后端——但**酷狗有一条不需要任何服务器的公开路径**，壳已经把它接通了：

| 能力 | 状态 |
|---|---|
| 搜索 | ✅ 可用（酷狗的匿名签名搜索，签名在网页层计算） |
| 播放 | ✅ **约六成曲目可播**；付费曲目会明确提示需要账号，而不是报"网络错误" |
| 歌词 | ✅ 可用 |
| 封面 | ✅ 可用 |
| 网易云 / QQ | ⚠️ **需要你自己部署一个 API 实例**，然后在「设置 → 集成 → 网易云 API 地址」里填地址（v0.3.1 起可在应用内直接填，不用重新打包）。见下节 |
| 波点音乐 | ❌ 桌面独占（依赖主进程里的 Node 包，网页版无法运行） |

**首次使用请先在音源选择里切到「酷狗」**：应用默认的活动音源是网易云，而在手机上它不可用。

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

**也就是说：网易不登录就不给音频地址。** 这跟酷狗匿名就能拿到约六成曲目完全不同，所以「像酷狗那样在网页层直连」这条路对网易走不通。

桌面版之所以能用，是因为它把 `@neteasecloudmusicapienhanced/api` 这个 **449 个路由模块的 Node 服务**跑在了 Electron 主进程里。浏览器和 WebView 跑不了它（依赖 `fs`/`crypto`/`http`、`anonymous_token`、xeapi 公钥与设备注册）。

### 所以：部署一个实例，然后在应用里填地址

v0.3.1 起，「设置 → 集成 → 网易云 API 地址」可以直接填，**改完立刻生效，不用重新打包**（上游原本只有构建期变量 `VITE_NETEASE_API_BASE`，对已经装在手机上的 APK 没有意义）。

几点实测与提醒：

- **用 https 的实例**。请部署**独立的网易 API 实例**（Vercel / Cloudflare Workers 的免费额度够用，或自己的 Docker 加 TLS 反代）。安卓壳只对音源域名开了明文白名单，`http://` 的局域网地址会被系统策略拦掉。
- **不要直接填 Folia Docker 全栈的 `/netease/` 路由**。那个 gateway 段（`deploy/docker/gateway/nginx.conf.template` 的 `location /netease/`）**不加 CORS 头**——它服务的是同源的 Web 页面，用不上。安卓壳是**跨源**调用，会被浏览器拒收。要复用它就得在该 location 里补上 CORS 头，并解决明文限制。
- **独立实例的 CORS 是自带的，实测可用**：Express 中间件会**回显 Origin**（不是 `*`）并带 `Access-Control-Allow-Credentials: true`。这一点很关键——应用的请求带 `credentials: 'include'`，如果服务端回 `*`，浏览器会直接拒收，而回显 Origin 就没问题。所以不需要在壳里加代理层。
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
```

- **0001 无句柄本地导入**：新增 OPFS 音频字节仓、`importLocalFiles(File[])` 与文件选择器入口、让 `FileEntryForImport.handle` 可选、三个播放访问器加字节仓回退、无句柄根目录不可重扫、以及让本地页签在只有文件导入可用时也可进入。
- **0002 酷狗免服务器路径**：传输层增加 `anonymous-public` 模式与能力声明，使音源在匿名模式下真正可选。
- **0003 设备音乐库**：新增 `deviceAudioLibrary` / `deviceAudioSync` 两个服务，`LocalSong` 增加 `deviceAudioId`，播放来源解析为流地址。
- **0004 网易 API 地址运行时可配置**：新增 `providerApiBase` 服务持有"哪个网关生效"，`netease.ts` 反向委托；集成设置新增输入项与连通性测试，并接入命令面板与三份 i18n。
- **0005 画布像素倍率封顶**：新增 `canvasPixelRatio` 把 `devicePixelRatio` 钳到 1..2，cadenza / monet / pendolo / fume 四处画布的后备缓冲与 `setTransform` 同步改用同一倍率。上游 `lumiere` 早有同样取舍（`LUMIERE_MAX_RENDER_RESOLUTION`），这里只是补齐遗漏的渲染器。
- **0006 手机壳首启默认 60 帧**：新增 `isAndroidShell`（看 `window.foliaAndroid` 是否存在，不看 UA）与 `ensureVisualizerFrameRateDefault`（只在存储里没有记录时播种，写进存储而不是只交给限帧器，保证图形设置与实际生效一致），启动期在装上限帧器之前调用。桌面与浏览器构建不受影响。
- **0007 应用内帧率 HUD**：新增 `frameSamples` 采样器（预分配环形缓冲、每帧零分配、不碰 React；采样走限帧器保存的原生 rAF，否则只会测到我们自己的上限；超过 250ms 的间隔不计入，那是切后台而非掉帧）与 `FrameStatsHud`（500ms 轮询，长按左上角开关，监听挂在 window 捕获阶段且不 `preventDefault`，不会抢走播放器的输入）。

`web/` 的内容等于「上游 v0.7.20 + 这七个补丁」，可据此审计。

## 为什么壳里绝不申请音频焦点

音频始终由 WebView 内的 Chromium 媒体栈播放。原生侧若再申请音频焦点会把它顶掉，页面收到 `AUDIOFOCUS_LOSS` 后立即自动暂停——表现为"一按播放就停"。壳的职责只有三件：把进程提到前台优先级、提供通知栏与锁屏传输控制、把系统事件（耳机拔出、语音搜索）翻译成给页面的命令。

## 许可

**AGPL-3.0**，与上游一致。`web/` 是上游 `chthollyphile/folia-major` v0.7.20 的完整源码（AGPL-3.0），壳代码以同一许可发布。详见 `NOTICE`。
