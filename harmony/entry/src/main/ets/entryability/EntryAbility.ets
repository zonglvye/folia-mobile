import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { playbackSession } from '../shell/PlaybackSession';
import { ShellLog } from '../shell/ShellLog';
import { NetworkMonitor } from '../shell/NetworkMonitor';

// harmony/entry/src/main/ets/entryability/EntryAbility.ets
// 应用入口：加载首页、强制全屏沉浸、常亮，并把播放会话建起来。
//
// 对应安卓壳 MainActivity 里那几行：setRequestedOrientation（横屏在 module.json5 声明）、
// 沉浸式（setWindowLayoutFullScreen）、以及 PlaybackService 的启动。
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 第一件事：把日志通道挂上，后面所有壳日志才能落进沙箱文件（见 ShellLog 的文件头）。
    ShellLog.attach(this.context);
    ShellLog.info('EntryAbility onCreate');

    // 联网状态要早于页面就位：代理桥在被调用时会先问它（见 shell/NetworkMonitor）。
    NetworkMonitor.start();

    // 调试通道：让 ArkWeb 暴露 devtools 的 unix socket，之后 `hdc fport tcp:9333
    // localabstract:webview_devtools_remote_<pid>` 就能用 CDP 连进页面，直接读 DOM 几何、
    // 命中元素和计算样式。截图看不出「按钮为什么点不到、图标为什么透明」，这是唯一可靠的手段。
    // 只在本机开发/自用装机上起作用（外部不接 fport 就打不开），因此保留。
    webview.WebviewController.setWebDebuggingAccess(true);
    ShellLog.info('web debugging access enabled');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        console.error(`[EntryAbility] loadContent failed: ${error.code} ${error.message}`);
        return;
      }
      const mainWindow = windowStage.getMainWindowSync();
      // 音乐观赏播放器：画面铺满、屏幕常亮、系统栏隐藏（与安卓壳的沉浸式一致）。
      mainWindow.setWindowLayoutFullScreen(true).catch((reason: BusinessError) => {
        console.warn(`[EntryAbility] full screen failed: ${reason.message}`);
      });
      mainWindow.setWindowKeepScreenOn(true).catch((reason: BusinessError) => {
        console.warn(`[EntryAbility] keep screen on failed: ${reason.message}`);
      });
      mainWindow.setWindowSystemBarEnable([]).catch((reason: BusinessError) => {
        console.warn(`[EntryAbility] hide system bars failed: ${reason.message}`);
      });
      // AVSession：后台播放与锁屏控制的地基（见 PlaybackSession 的文件头）。
      playbackSession.start(this.context).catch((reason: BusinessError) => {
        console.warn(`[EntryAbility] AVSession start failed: ${reason.message}`);
      });
    });
  }

  onWindowStageDestroy(): void {
    playbackSession.stop().catch(() => undefined);
  }

  onDestroy(): void {
    console.info('[EntryAbility] onDestroy');
    NetworkMonitor.stop();
  }
}
