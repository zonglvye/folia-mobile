import { hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

// harmony/entry/src/main/ets/shell/ShellLog.ets
// 壳自己的日志通道：同时写系统日志和沙箱里的一个文件。
//
// 为什么还要写文件：在这个环境里 ArkTS 的 console **和 hilog 都读不出来** ——
// 实测 `hdc shell hilog -x` 里既没有 console.info，也没有 hilog.info(0xF0F0, 'Folia', ...)，
// 而页面明明渲染正常。于是「页面对壳说了什么、壳又回了什么」全看不见，排查网易云登录
// 这种问题就是睁眼瞎。文件是唯一确定能读回来的通道。
//
// 真机上看日志（沙箱目录对 shell 用户可读，实测通过）：
//   hdc shell cat /data/app/el2/100/base/app.folia.mobile/haps/entry/files/folia.log
// 清空：删掉这个文件即可，下次写入会重新创建。
export class ShellLog {
  /** 工程专用日志域（大部分 0x0xxx 是系统保留的，挑一个靠后的自用域）。 */
  private static readonly DOMAIN: number = 0xF0F0;
  private static readonly TAG: string = 'Folia';
  private static logPath: string = '';
  private static attached: boolean = false;

  /** 由 Ability 在启动时调用一次，之后所有日志都会落到沙箱里。 */
  static attach(context: common.UIAbilityContext): void {
    ShellLog.logPath = `${context.filesDir}/folia.log`;
    ShellLog.attached = true;
    ShellLog.info('=== shell attached ===');
  }

  /** 把一行里的换行压平，免得一条日志撑成几十行。 */
  static flatten(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /** 截断一段可能很长的文本（响应体预览用）。 */
  static preview(text: string, max: number): string {
    const flat = ShellLog.flatten(text);
    return flat.length <= max ? flat : `${flat.slice(0, max)}...(${flat.length})`;
  }

  static info(message: string): void {
    ShellLog.emit('I', message);
  }

  static warn(message: string): void {
    ShellLog.emit('W', message);
  }

  static error(message: string): void {
    ShellLog.emit('E', message);
  }

  private static emit(level: string, message: string): void {
    const flat = ShellLog.flatten(message);
    if (level === 'E') {
      hilog.error(ShellLog.DOMAIN, ShellLog.TAG, '%{public}s', flat);
    } else if (level === 'W') {
      hilog.warn(ShellLog.DOMAIN, ShellLog.TAG, '%{public}s', flat);
    } else {
      hilog.info(ShellLog.DOMAIN, ShellLog.TAG, '%{public}s', flat);
    }
    ShellLog.writeToFile(level, flat);
  }

  /**
   * 追加一行。每次重新 open/close：fileIo 没有 appendFile，常驻 fd 又要处理生命周期，
   * 而这些日志是事件驱动的（不是每帧），开销无所谓。
   */
  private static writeToFile(level: string, message: string): void {
    if (!ShellLog.attached || ShellLog.logPath.length === 0) {
      return;
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(ShellLog.logPath,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
      fs.writeSync(file.fd, `${ShellLog.stamp()} ${level} ${message}\n`);
    } catch (error) {
      // 日志写不进去绝不能反过来影响功能。
    } finally {
      if (file !== null) {
        try {
          fs.closeSync(file);
        } catch (ignored) {
          // 同上。
        }
      }
    }
  }

  private static stamp(): string {
    const now = new Date();
    const pad = (value: number): string => value < 10 ? `0${value}` : `${value}`;
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds())}`;
  }
}
