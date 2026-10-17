# iOS 端：三条路和它们的代价

> 写这份东西的原因是：仓库里现在那句「iOS 走纯 PWA（壳解决不了 iOS，且 iOS 上无法锁定横屏）」
> 有一半是错的，而剩下那一半也没说清代价。下面是重新核过一遍的结论。
>
> 状态：**分析，未动手**。里面标了「待真机确认」的几条必须在 iPhone 上验过才能当结论用。

## 决定（2026-10-17）：冻结，不写代码

问清楚了：**没有 iPhone，也没有 Mac。**

这两条一起把三条路里的两条直接划掉：

- **B（WKWebView 壳）**：没有 Mac 就编译不了 Xcode 工程，连「能不能跑起来」都无从谈起。而且它还要 $99/年的开发者账号才发得出去。**不做。**
- **A（纯 PWA）**：技术上一分钱不花（静态托管 + Safari 添加主屏幕，**不需要 Mac**），但这里没有一台 iOS 设备，所以「主屏 PWA 认不认横屏、锁屏后音频还响不响」这类只有真机能回答的问题，一个都答不了。发一个自己没测过的东西，和这个项目到目前为止的规矩正相反。

所以 iOS 现在的状态是：**没有可用版本**，公开仓库的 README 已经这么写（顺带改掉了原来那句错的「壳解决不了 iOS」）。

**重新打开的触发条件**（满足任意一条再说）：

1. 手上有了一台 iOS 设备（哪怕借来一小时）→ 先把下面「待真机确认」四条跑完，A 的可行性当场就有答案；
2. 有了一台 Mac → 同时也有了做 B 的动力，那时再谈开发者账号；
3. 有 iOS 用户在 issue 里明确要 → 先只回答「为什么还没有」，不急着自己实现。

**为什么这个决定是安全的**：这套 Web 代码不需要为 iOS 做任何预埋。真正的分叉点只有三处（安全源、同源代理、屏幕方向与媒体），而这三处现在都由壳提供；将来真要接 iOS，是在壳那一层加一个实现，不是回头改 Web 层。现在写 `isIOSRuntime()` 之类的分支，等于为一条没有设备的路径留一堆无法验证的代码。


## 先说清一件事：为什么 Android 那套搬不过去

Android 壳能成立，靠的是三件恰好都在 Android 上存在的东西：

| Android 能力 | 用来干什么 | iOS 上的对应物 |
|---|---|---|
| `WebViewAssetLoader` 挂在虚拟 https 源 | 页面是 secure context → IndexedDB / OPFS / `crypto.subtle` 全可用，离线是结构性的 | **没有等价物**。`WKURLSchemeHandler` 只能注册自定义 scheme，而自定义 scheme 不是 secure context |
| 原生实现 `/api/lyric-proxy`、`/api/netease-proxy` | 绕开 CORS，网易/酷狗能“不需要任何服务器” | 需要自己做一个同源端点，否则网页版得自部署实例 |
| `MediaStore` + 前台服务 + MediaSession | 打开就看到手机里的歌、后台出声、通知栏控制 | `MPMediaLibrary` 只能导出**无 DRM** 的本地文件；后台音频要 `UIBackgroundModes` |

第一行是最要命的一条。`crypto.subtle` 不存在，网易的 eapi/weapi 加密就整条断掉；OPFS 不可用，
「无句柄本地导入」那条路（patch 0001）也断掉。所以「iOS 壳 = 照抄 Android 壳」在这里不成立。

## 三条路

### A. 纯 PWA（零新代码，今天就能有）

把 `web/dist` 部署到任意静态托管，Safari 打开 →「添加到主屏幕」。

- **拿到**：离线（Safari 的 service worker 可用）、本地文件导入（`<input type="file">`，patch 0001 已支持）、
  播放、歌词、完整的可视化器。不需要 Apple 账号，不需要审核，不需要 Mac。
- **拿不到**：
  - **锁横屏**。`screen.orientation.lock()` 在 iOS Safari 上不可用，主屏 PWA 是否遵守 manifest 里的
    `orientation: landscape` —— **待真机确认**（历史上 iOS 忽略它）。也就是说「锁横屏的音乐观赏播放器」
    这个定位在 iOS 上可能只剩「请你把手机横过来」。
  - **在线音源**。页面直连网易域名被 CORS 挡，iOS 又没有原生代理可写 → 必须自部署一个实例，
    在应用里填地址（这条路 v0.3.1 就已经做好了，是现成的）。**酷狗的匿名路径同样需要那个代理**，
    所以 iOS PWA 上网易和酷狗都需要一个实例。
  - **设备音乐库**。浏览器拿不到 MediaStore 的对应物，只能在文件选择器里挑文件。
  - **后台播放的可靠性**。主屏 PWA 在锁屏/内存压力下，WebKit 可能把页面进程回收，音频随之停。
    这是 iOS PWA 长期存在的问题，**待真机确认**当前 iOS 版本的表现。
  - 存储没有 `persist()` 保障，可能被系统回收（曲库和登录态一起）。

### B. WKWebView 壳（和 Android 对齐，成本最大）

一个 Swift 宿主 App：把 `web/dist` 打进 bundle，在应用内起一个**只监听 127.0.0.1 的小 HTTP 服务**，
WebView 加载 `http://127.0.0.1:<port>/`。

为什么必须是环回 HTTP 而不是 `file://` 或自定义 scheme：
`file://` 和自定义 scheme 都是 opaque origin，既不提供 secure context（`crypto.subtle` 不可用），
`localStorage` / IndexedDB 在上面也不可靠。而按 Secure Contexts 规范，`127.0.0.1` / `localhost`
属于 potentially trustworthy origin，所以走环回 HTTP 反而**同时**拿到 secure context 和真实可用的存储。
（这也是别人踩过同一个坑后的做法：把 iOS WebView 从自定义 scheme 换到 secure-context 源。）

在这之上，Android 那三件事都有对应物：

| 需要的 | iOS 怎么写 | 风险 |
|---|---|---|
| 同源 API 代理 | 环回服务的 `/api/lyric-proxy`、`/api/netease-proxy` 两条路由，转发逻辑与 `NeteaseProxyHandler.java` 同一份契约 | 低，纯移植 |
| 锁横屏 | `Info.plist` 的 `UISupportedInterfaceOrientations` 只留横屏 —— **这是壳相对 PWA 最实在的一个优势** | 低 |
| 后台音频 | `UIBackgroundModes: audio` + `AVAudioSession(.playback)` + `mediaTypesRequiringUserActionForPlayback = []`；锁屏控制走 Media Session | 中，**待真机确认**（iOS 会在内存压力下回收 WebContent 进程） |
| 设备音乐库 | `MPMediaLibrary` + `AVAssetExportSession` 导出无 DRM 曲目到沙盒再读 | **高**，Apple Music 流媒体曲目导不出来，等于只支持本地导入的曲库。建议 v1 不做 |
| 通知栏 / 锁屏 | Media Session 元数据（WebKit 支持），原生侧只需要 AVAudioSession | 低 |

- **成本**：约 1500–2000 行 Swift，一台 Mac + Xcode。
- **分发**：App Store 或 TestFlight 需要 Apple Developer Program（**$99/年**）+ 审核；没有账号只有
  7 天一次的自签名（AltStore 那类），装在一个每天用的播放器上不现实。

### C. 先 A 后 B

先发 PWA，把「iOS 能用」这件事落地（几小时的事），只在你真的拿 iPhone 当主力听歌时才做 B。
B 的架构现在已经被 Android 那一轮试错验证过了（三处接缝：安全源、同源代理、媒体与屏幕方向），
所以它是一个有边界的项目，不是又一次探索。

## 如果将来真要开工（条件见上面「决定」一节）

那时按这个顺序做，而不是现在提前铺代码：

1. 先跑完「待真机确认」那四条。第 1、2 条决定 A 到底成不成立，第 4 条决定 B 的地基在不在。
2. 真要做 A：加一个 `isIOSRuntime()` 和一份**能力声明**（`canLockOrientation` / `hasNativeProxy` /
   `hasDeviceLibrary` / `hasServiceWorker`），让 UI 按「这台设备有什么」降级，而不是按「是不是 Android」分支。
   现在 `isAndroidRuntime()` 已经开始承担这个角色（发光、背景预算都按它切），iOS 一进来
   `!isAndroidRuntime()` 这种写法就会立刻开始撒谎。
3. A 上要换掉的宣传语：iOS 的「网易/酷狗不需要服务器」不成立，得指向自部署实例（v0.3.1 那条路是现成的）。
4. 竖屏兜底做成通用的：Android 壳已经有一张「请横过来」的原生覆盖层，PWA 里用同一份文案做成 DOM 层。

**在拿到那几条答案之前，一行 iOS 代码都不要写** —— 理由就是「决定」那一节最后一条：
真正的分叉点都在壳那一层，Web 层不需要预埋；预埋出来的分支没法验证，只会变成负担。

## 四个问题的答案（2026-10-17）

1. **有 iPhone 吗** —— 没有。
2. **有 Mac 吗** —— 没有。
3. **愿不愿付 $99/年** —— 没有前两条时这个问题不成立，暂不问。
4. **目标是「能用」还是「和 Android 一样」** —— 没有设备时也不成立：连「能用」都没法确认。

剩下的两个真问题，等有设备时再问：

- 那台设备的 iOS 版本是多少（决定 `screen.orientation`、OPFS、manifest `orientation` 分别是哪一档行为）。
- 那台设备能不能借来装一次主屏 PWA 并按下面四条验一遍。

## 待真机确认的清单（有 iPhone 之后按这个顺序验）

1. 主屏 PWA 是否遵守 manifest 的 `orientation: landscape`（不遵守 → A 的定位要改说法）
2. 锁屏 1 分钟后音频是否继续（不继续 → A 只能当「亮屏观赏」，B 才有意义）
3. `navigator.storage.persist()` 在 iOS 上的实际返回值，以及缓存被系统清掉之后曲库还在不在
4. `crypto.subtle` 在环回 HTTP 源上是否可用（B 的地基，必须在写 Swift 之前验）

前三条**只需要一台 iPhone**（Safari 就行，不需要 Mac、不需要开发者账号、不需要打包）——
所以哪怕只是借一台设备半小时，「A 到底能不能用」这个问题的答案也就有了。
