import { appTasks } from '@ohos/hvigor-ohos-plugin';

// 根构建脚本。这里的 hvigor / SDK 版本号以 DevEco Studio 自带的为准：
// 用 DevEco 打开本目录时它会提示 sync，必要时会把 hvigor-config 的版本对齐到本机 SDK。
export default {
  system: appTasks,
  plugins: [],
};
