# Folia Mobile · 鸿蒙壳

Folia 的 HarmonyOS 外壳：ArkTS + ArkUI + ArkWeb，把同一份 `web/dist` 装进
`entry/src/main/resources/rawfile/www`，用虚拟 https 源（`appassets.androidplatform.net`）
发出去，因此 IndexedDB / Cache Storage 的行为与安卓壳一致。

界面与逻辑全在 web 层；这一层只做 shell 该做的事：

- 静态资源服务（`shell/AssetServer.ets`）
- 同源代理 `/api/lyric-proxy`、`/api/netease-proxy`（`shell/HttpProxy.ets`）：
  白名单域名、白名单请求头，支持 GET 与 POST。酷狗的手机号登录与账号接口走这里
- 网易中转页（`shell/WebNeteaseBridge.ets`）：同源 fetch，保住登录态
- 媒体缓存与 Range 响应（`shell/MediaCache.ets`）、断网监测（`shell/NetworkMonitor.ets`）
- 锁屏 / 通知栏控制（`shell/PlaybackSession.ets`，AVSession）

## 构建

依赖：DevEco Studio（含 SDK API 26）与 hvigor。构建脚本用 DevEco 自带的 hvigor，
不依赖全局安装。

```powershell
# 1) 先构建 web（仓库根目录的 web/）
cd ..\web
npm ci
npm run build

# 2) 把 web/dist 同步进 rawfile/www（路径也可以 -WebDist 指定）
powershell -ExecutionPolicy Bypass -File .\tools\sync-web-assets.ps1

# 3) 打包
powershell -ExecutionPolicy Bypass -File .\tools\build-hap.ps1
```

`build-hap.ps1` 会打印 HAP 路径与 SHA-256。**签名要在 DevEco Studio 里配**
（File → Project Structure → Signing Configs）；没配签名时产物是未签名的，
只能说明编译通过，不能直接安装。

装到设备：

```powershell
hdc install -r entry\build\default\outputs\default\entry-default-signed.hap
```

## 已知限制

- `rawfile/www` 不入库（由第 2 步生成）。没有它，工程能编译但页面是空的。
- 代理的域名白名单是安全边界：只放行 `*.kugou.com`、`*.qq.com`、`y.gtimg.cn` 与网易媒体域名。
  改白名单前先想清楚，这条代理等于壳的网络权限。
- 模拟器与真机在 ArkWeb 的资源拦截、媒体 Range 行为上不一致；改动 `AssetServer` /
  `MediaCache` 后请在真机上验一遍。
