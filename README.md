# Folia Mobile

把 [Folia](https://github.com/chthollyphile/folia-major) 带到手机上的非官方移植。

- **Android**：一个自带 Web 产物的壳（WebView），所以离线是结构性的而不是"尽力而为"。
- **iOS**：纯 PWA（壳解决不了 iOS，且 iOS 上无法锁定横屏）。
- 定位：**锁横屏的音乐观赏播放器**。

> 本项目与上游 Folia 作者无隶属关系，是一个社区移植。

## 下载

到 [Releases](../../releases) 下载 APK。

> ⚠️ **当前版本尚未在真机上验证过。** 它能编译、能通过全部单元测试，但"在手机上打开会不会白屏、能不能真的导入并播放本地音乐"没有实测结论。装上后如果有问题，欢迎带着 `adb logcat -s FoliaShell` 的输出开 issue。

系统要求：Android 8.0+（minSdk 26）。

## 现在能用什么、不能用什么

**已完成**

- 壳：用 `WebViewAssetLoader` 把 APK 内的 Web 产物挂在虚拟 https 源上（`appassets.androidplatform.net`）——页面因此仍是 secure context，IndexedDB / OPFS / Cache Storage 全部可用，这也是离线能成立的原因。
- 沉浸式全屏、锁横屏，以及**竖屏兜底**（系统方向锁可以压过应用的横屏请求，所以竖屏时给一张可读的提示层）。
- 文件选择（含多选，WebView 的 `ClipData` 陷阱已处理）。
- 前台媒体服务 + MediaSession + 通知卡片（**原生侧刻意不申请音频焦点**，见下）。
- **本地音乐导入**：不依赖 `showDirectoryPicker`，安卓与 iOS 的浏览器都能用；导入的音频字节写入 OPFS，播放时无需文件句柄。

**未完成**

- 后台播放的 Web 侧快照推送钩子未接，所以媒体通知目前收不到数据（服务已就绪）。
- **在线音源需要自建 API 网关**：桌面版是把网易云 / QQ / 酷狗的 API 后端内置在主进程里的，Web 与壳形态没有这些后端。想用在线音源必须自己部署（仓库里 `vercel.json`、`wrangler.jsonc`、`deploy/` 是为此准备的）。
- SAF 整目录导入、`audio/*` 唤起、应用自更新：接口名已预留但**故意不注册空方法**，以保证页面的逐方法能力探测是诚实的。

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

上游源码完整保留在 `web/`，我们的唯一改动是**为本地曲库增加一条无文件句柄的导入路径**，以补丁形式放在 `patches/`：

```
patches/0001-local-music-file-import.patch
```

改动要点：新增 OPFS 音频字节仓、`importLocalFiles(File[])` 与文件选择器入口、让 `FileEntryForImport.handle` 可选、三个播放访问器加字节仓回退、无句柄根目录不可重扫、以及让本地页签在只有文件导入可用时也可进入。

`web/` 的内容等于「上游 v0.7.20 + 该补丁」，可据此审计。

## 为什么壳里绝不申请音频焦点

音频始终由 WebView 内的 Chromium 媒体栈播放。原生侧若再申请音频焦点会把它顶掉，页面收到 `AUDIOFOCUS_LOSS` 后立即自动暂停——表现为"一按播放就停"。壳的职责只有三件：把进程提到前台优先级、提供通知栏与锁屏传输控制、把系统事件（耳机拔出、语音搜索）翻译成给页面的命令。

## 许可

**AGPL-3.0**，与上游一致。`web/` 是上游 `chthollyphile/folia-major` v0.7.20 的完整源码（AGPL-3.0），壳代码以同一许可发布。详见 `NOTICE`。
