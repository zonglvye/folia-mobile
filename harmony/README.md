# Folia HarmonyOS（鸿蒙原生壳）

同一个应用（`web/`）的第三个外壳，和 `android/`（Java + WebView）平级，但**不在同一个目录树里**：

| 目录 | 是什么 |
| --- | --- |
| `D:\dhs\开发\folia-mobile\web` | 整个应用本体（React + Vite，`npm run build` 出 `web/dist`） |
| `D:\dhs\开发\folia-mobile\android` | 安卓壳：WebViewAssetLoader + Java 桥 + 前台服务 |
| `E:\huawei\harmony` | **本目录**：ArkTS + ArkWeb 的鸿蒙壳 |

搬到 `E:` 是因为 **hvigor 拒绝非 ASCII 的工程路径**，而 `D:\dhs\开发\...` 里那个「开发」直接
把工程挡在编译器外面（见下面的「怎么编译」）。鸿蒙壳有自己的 git 仓库，搬动不影响 `web/`。

## 现在是什么状态（重要，别当成已完成）

| 项 | 状态 |
| --- | --- |
| **编译** | **通过**（DevEco Studio 26.0.0.851 / HarmonyOS SDK 26.0.0 / API 26，hvigor 6.26.8）。产出未签名 HAP 19.54 MB，在工程原地编译 |
| 工程配置（hvigor / module / app） | 已按本机 SDK 对齐；`compatibleSdkVersion` 与 `targetSdkVersion` 都是 `"26.0.0"`（**不是**旧写法 `"5.0.0(12)"`，带括号的写法在这个 SDK 上直接报 `api version parameter is illegal`） |
| ArkWeb 承载 + 虚拟 origin + 资源拦截 | 编译过，**未上机** |
| `window.foliaAndroid` 桥 | `getShellKind` / `setPlaybackSnapshot` / 两个权限方法（恒 false）。编译过，未上机 |
| 锁屏 / 控制中心（AVSession） | 完整实现：镜像元数据与播放状态、按键回传、`audioPlayback` 长时任务。编译过，**未上机** |
| 歌词/网易云代理 | 按安卓实现逐字段移植（信封、域名白名单、POST 重放、Set-Cookie 拉平）。编译过，**未验证上游连通性** |
| 声音 | **已确认可用**：鸿蒙浏览器里 ArkWeb 的 `<audio>` 能出声（真机验证），所以声音由页面自己出，不需要原生播放器 |
| 设备音乐库（MediaStore 那一套） | **未实现**，见 PORT.md 的风险 1 |
| 签名 / 上架 | 未做，需要华为开发者账号（`File → Project Structure → Signing Configs`） |

> 剩下的 8 条编译告警都是同一句 `Function may throw exceptions. Special handling is required.`，
> 指的是 `setAVMetadata` / `setAVPlaybackState` / `activate` 这类可能同步抛错的调用。它们已经各带
> `.catch()`，不影响构建。
>
> `HttpProxy` 里那几个纯函数（路径匹配、query 解码、Set-Cookie 拉平、URL 拆解、mime/charset、
> 响应头大小写）另有可运行的回归用例 —— 它们是「不报错但会静默坏掉」的那一类：
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File tools/check-ets-helpers.ps1
> # ok x13 / 13 passed
> ```

## 怎么编译

工程现在就在 ASCII 路径上，**原地编译**：

```powershell
powershell -ExecutionPolicy Bypass -File E:\huawei\harmony\tools\build-hap.ps1
# Build in place : E:\huawei\harmony
# BUILD SUCCESSFUL
# HAP: entry\build\default\outputs\default\entry-default-unsigned.hap  19.54 MB
```

脚本会自己找到 DevEco Studio（快捷方式 + 常见安装路径），设好 `DEVECO_SDK_HOME` /
`NODE_HOME` / `JAVA_HOME`，并在前后清掉 hvigor 守护进程 —— 守护进程会继承启动时的环境，
带着没有 `java` 的旧环境跑打包就会报 `spawn java ENOENT`。

**如果有人把工程挪回非 ASCII 路径**，脚本会自动镜像到 `D:\folia-hap-src` 再编（hvigor 会报
`00306003 Invalid project path`，这是它自己的限制，不是我们的配置问题）。但那样 DevEco 就没法
直接打开工程了，所以别挪回去。

需要装新的 web 产物时先跑一次同步：

```powershell
cd D:\dhs\开发\folia-mobile\web; $env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm run build
powershell -ExecutionPolicy Bypass -File E:\huawei\harmony\tools\sync-web-assets.ps1
# rawfile/www synced: 1868 files, 19.1 MB
```

`web/dist` 已经不在本工程的上级目录里了，脚本按这个顺序找它：`-WebDist <path>` 参数 →
上级目录的 `web\dist` → `tools/web-dist-path.txt` 第一行（这台机器上就是
`D:\dhs\开发\folia-mobile\web\dist`，该文件是本地配置、不进版本库 —— 路径含中文，塞不进
纯 ASCII 的 `.ps1`）。

**在 DevEco 里调试**：`File → Open` 选 `E:\huawei\harmony` 就行 —— 工程在 ASCII 路径上，
不再需要镜像目录那一套。改完代码在 DevEco 里直接 Run。

> 这个盘是 **exFAT**，两件事跟着来：① git 不认它的文件属主，第一次用会报 `dubious ownership`，
> 已经执行过 `git config --global --add safe.directory E:/huawei/harmony`；② exFAT 不支持硬链接，
> 某些工具的「原子写」会失败（写新文件时报 EISDIR/EINVAL 之类）。不喜欢的话，换个 NTFS 盘符
> 放这个目录即可，脚本和 DevEco 都不在意具体盘符，只在意路径里没有中文。

## 怎么上真机

1. DevEco 里 `File → Project Structure → Signing Configs`，勾自动签名（登录华为账号，需要
   HarmonyOS 开发者身份；免费）
2. 手机开「开发者模式 + USB 调试」，DevEco 认到设备后 Run
3. 装的是未签名 HAP 装不上去 —— 签名这一步绕不开，鸿蒙 NEXT 不接受任何未签名包

> `AppScope/resources/base/media/app_icon.png` 与 `entry/.../media/app_icon.png` 现在是脚本生成的占位图
> （512×512，深底圆点）。正式发版请换成真图标。

## 目录

```
harmony/
  AppScope/app.json5                应用级清单（包名、图标、版本）
  build-profile.json5               构建配置（SDK 版本、签名位）
  hvigorfile.ts / oh-package.json5  构建脚本与依赖
  entry/
    build-profile.json5             模块构建配置
    src/main/module.json5           模块清单（权限、Ability、横屏、后台任务）
    src/main/ets/
      entryability/EntryAbility.ets 应用入口：加载首页、沉浸式、横屏
      pages/Index.ets               ArkWeb 宿主（虚拟 origin + 拦截 + 桥）
      shell/AssetServer.ets         把 rawfile/www 当网站根发出去
      shell/FoliaBridge.ets         window.foliaAndroid 的 ArkTS 实现
      shell/HttpProxy.ets           /api/lyric-proxy、/api/netease-proxy
      shell/PlaybackSession.ets     AVSession：锁屏 / 控制中心镜像 + 按键回传 + 后台长时任务
    src/main/resources/rawfile/www/ web 构建产物（脚本拷入；目录由脚本创建，不进版本库）
  tools/sync-web-assets.ps1         web/dist → rawfile/www（自动找 web/dist，见上）
  tools/build-hap.ps1               编译 HAP（工程在非 ASCII 路径上时会先镜像出去）
  tools/check-ets-helpers.ps1       在 Node 里跑 HttpProxy 纯函数的回归用例
  tools/proxy-parsing.cases.js      那些用例本身
  tools/web-dist-path.txt           本机 web/dist 的路径（本地配置，不进版本库）
  PORT.md                           逐项移植图与风险
```

## 为什么用虚拟 https origin 而不是 file://

和安卓壳同一个理由：`file://` 页面不是安全上下文，IndexedDB / Cache Storage / service worker 会被收走，
而这个应用的曲库、主题、歌词、媒体缓存全在 IndexedDB 里。所以 ArkWeb 里由 `AssetServer` 拦截
`https://appassets.androidplatform.net/*`（沿用安卓壳的同一个 origin），把 rawfile 的内容当成 http 响应发回去。
`rawfile/www` 里没有的网络请求（在线歌曲、歌词）不在这个 origin 下，不受影响。
