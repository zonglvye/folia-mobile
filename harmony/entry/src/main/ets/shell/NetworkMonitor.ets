import { connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ShellLog } from './ShellLog';

// harmony/entry/src/main/ets/shell/NetworkMonitor.ets
//
// 壳这一侧的联网状态。真机实测（2026-10）：断网时中继页里的 fetch 会**挂住**，不是立刻失败 ——
// `WebNeteaseBridge` 等 20s 才超时，再退回系统网络栈又是 3×10s；页面那边的代理客户端 30s 就放弃了，
// 用户看到的是「点了没反应，过一会儿才报连接失败」。有了这里的状态，断网时可以直接给失败，
// 不必把时间耗在注定失败的请求上。
//
// 事件里不能直接拿事件本身当答案：netLost 只说明**某一张网**断了（Wi-Fi 掉了但蜂窝还在是常态），
// 所以每次事件都延迟一点再问 `getDefaultNetSync()`，以默认网络为准。
// 权限：module.json5 里已声明 ohos.permission.GET_NETWORK_INFO。

/** 联网状态变化回调。 */
export type NetworkChangeListener = (online: boolean) => void;

/** netLost 之后稍等一下再探测：默认网络可能正在从 Wi-Fi 切到蜂窝。 */
const PROBE_DELAY_MS: number = 400;

export class NetworkMonitor {
  /** 最近一次确认的状态。启动时先问一次，拿不到就按在线处理（宁可多试一次，也不要把能用的网判成断的）。 */
  private static online: boolean = true;
  private static started: boolean = false;
  private static netConnection: connection.NetConnection | null = null;
  private static listeners: NetworkChangeListener[] = [];

  /** 当前是否联网。 */
  static isOnline(): boolean {
    return NetworkMonitor.online;
  }

  /** 订阅状态变化；已经在跑的话立刻回调一次当前状态。 */
  static onChange(listener: NetworkChangeListener): void {
    NetworkMonitor.listeners.push(listener);
    if (NetworkMonitor.started) {
      listener(NetworkMonitor.online);
    }
  }

  /** 启动监听；幂等。由 EntryAbility.onCreate 调一次。 */
  static start(): void {
    if (NetworkMonitor.started) {
      return;
    }
    NetworkMonitor.started = true;
    NetworkMonitor.probe('startup');

    try {
      const netConnection = connection.createNetConnection();
      netConnection.on('netAvailable', (handle: connection.NetHandle) => {
        ShellLog.info(`network event: netAvailable id=${handle.netId}`);
        NetworkMonitor.probeLater('netAvailable');
      });
      netConnection.on('netLost', (handle: connection.NetHandle) => {
        ShellLog.info(`network event: netLost id=${handle.netId}`);
        NetworkMonitor.probeLater('netLost');
      });
      netConnection.on('netUnavailable', () => {
        ShellLog.info('network event: netUnavailable');
        NetworkMonitor.probeLater('netUnavailable');
      });
      netConnection.register((error: BusinessError) => {
        if (error) {
          ShellLog.warn(`network listener register failed: code=${error.code} msg=${error.message}`);
        }
      });
      NetworkMonitor.netConnection = netConnection;
      ShellLog.info('network monitor started');
    } catch (error) {
      ShellLog.warn(`network monitor unavailable: ${String(error)}`);
    }
  }

  /** 停掉监听（目前只在页面销毁时用；进程活着就一直听着）。 */
  static stop(): void {
    const netConnection = NetworkMonitor.netConnection;
    NetworkMonitor.netConnection = null;
    NetworkMonitor.started = false;
    if (netConnection === null) {
      return;
    }
    try {
      netConnection.unregister((error: BusinessError) => {
        if (error) {
          ShellLog.warn(`network listener unregister failed: code=${error.code}`);
        }
      });
    } catch (error) {
      ShellLog.warn(`network monitor stop failed: ${String(error)}`);
    }
  }

  private static probeLater(reason: string): void {
    setTimeout(() => {
      NetworkMonitor.probe(reason);
    }, PROBE_DELAY_MS);
  }

  private static probe(reason: string): void {
    let online = NetworkMonitor.online;
    try {
      const handle = connection.getDefaultNetSync();
      online = handle !== undefined && handle !== null && handle.netId !== 0;
    } catch (error) {
      // 查不到就保持上一次的判断：误报“断网”会让所有请求直接失败，比多等一次更糟。
      ShellLog.warn(`network probe failed (${reason}): ${String(error)}`);
      return;
    }
    NetworkMonitor.update(online, reason);
  }

  private static update(online: boolean, reason: string): void {
    if (NetworkMonitor.online === online) {
      ShellLog.info(`network: ${online ? 'online' : 'offline'} (${reason}, unchanged)`);
      return;
    }
    NetworkMonitor.online = online;
    ShellLog.info(`network: ${online ? 'online' : 'offline'} (${reason})`);
    for (const listener of NetworkMonitor.listeners) {
      try {
        listener(online);
      } catch (error) {
        ShellLog.warn(`network listener failed: ${String(error)}`);
      }
    }
  }
}
