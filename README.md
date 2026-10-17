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
> - **v0.2.0 已在真机上确认可以启动**（壳、资源加载、Service Worker 这一层是活的）。
> - 但 v0.2.0 上**手动导入本地音乐没有成功**：本地页签停在「未检测到任何本地音乐」，点导入后出现的提示文案尚未确认，原因仍在排查。**v0.2.0 的本地导入路径目前不可信。**
> - **v0.3.0 新增的设备音乐库扫描尚未在真机上验证过**——它能编译、能通过全部单元测试，但没有实测结论。
>
> 装上后如果有问题，欢迎带 `adb logcat -s FoliaShell` 的输出开 issue。

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
| 网易云 / QQ | ❌ 需要你自己部署对应的 API 实例（仓库里的 `vercel.json`、`wrangler.jsonc`、`deploy/` 是为此准备的） |
| 波点音乐 | ❌ 桌面独占（依赖主进程里的 Node 包，网页版无法运行） |

**首次使用请先在音源选择里切到「酷狗」**：应用默认的活动音源是网易云，而在手机上它不可用。

为什么酷狗能免服务器：网页层自己实现了酷狗的匿名签名，缺的只是"谁来发这个请求"——浏览器直连拿不到 CORS 头。壳内有一个原生的 `/api/lyric-proxy`（与部署形态下 `api-ts/lyric-proxy.ts` 这个 serverless 函数同一份契约），由它负责发请求。页面因此只与自己的源通信，既不涉及 CORS，也不涉及混合内容。

为什么只有约六成曲目能播：酷狗的公开播放端点对头部版权内容返回"需要付费"且不给任何链接。实测 180 首去重曲目中，约 71 首属于这一类。这不是缺陷，是版权策略——壳会把它如实报成"需要付费"，不会假装是网络故障。

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
```

- **0001 无句柄本地导入**：新增 OPFS 音频字节仓、`importLocalFiles(File[])` 与文件选择器入口、让 `FileEntryForImport.handle` 可选、三个播放访问器加字节仓回退、无句柄根目录不可重扫、以及让本地页签在只有文件导入可用时也可进入。
- **0002 酷狗免服务器路径**：传输层增加 `anonymous-public` 模式与能力声明，使音源在匿名模式下真正可选。
- **0003 设备音乐库**：新增 `deviceAudioLibrary` / `deviceAudioSync` 两个服务，`LocalSong` 增加 `deviceAudioId`，播放来源解析为流地址。

`web/` 的内容等于「上游 v0.7.20 + 这三个补丁」，可据此审计。

## 为什么壳里绝不申请音频焦点

音频始终由 WebView 内的 Chromium 媒体栈播放。原生侧若再申请音频焦点会把它顶掉，页面收到 `AUDIOFOCUS_LOSS` 后立即自动暂停——表现为"一按播放就停"。壳的职责只有三件：把进程提到前台优先级、提供通知栏与锁屏传输控制、把系统事件（耳机拔出、语音搜索）翻译成给页面的命令。

## 许可

**AGPL-3.0**，与上游一致。`web/` 是上游 `chthollyphile/folia-major` v0.7.20 的完整源码（AGPL-3.0），壳代码以同一许可发布。详见 `NOTICE`。
