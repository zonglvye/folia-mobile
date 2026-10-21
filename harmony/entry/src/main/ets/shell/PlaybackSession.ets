import { avSession } from '@kit.AVSessionKit';
import { common, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { webview } from '@kit.ArkWeb';
import { image } from '@kit.ImageKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { NowPlayingArtwork } from './NowPlayingArtwork';
import { ShellLog } from './ShellLog';

// harmony/entry/src/main/ets/shell/PlaybackSession.ets
// 锁屏 / 控制中心 / 蓝牙按键的那一层 —— 安卓侧是 PlaybackService 里的 MediaSession + 前台服务通知。
//
// 结论已经定下来了（见 PORT.md 风险 2）：ArkWeb 里的 <audio> 能出声，所以声音永远由页面自己出，
// 这个类只做两件事：
//   1. 页面推快照上来 -> 镜像给 AVSession（标题、艺人、专辑、进度、放/停）；
//   2. 系统上按了什么 -> 派发 `folia-android-media-command` DOM 事件回页面。
// 它不持有一个播放器，也**不申请音频焦点**：焦点属于页面的媒体栈，第二个持有者会让页面收到
// 失焦自动暂停，症状就是「一按播放就停」。这条坑与安卓壳一致（见 PlaybackService 的注释）。
//
// 快照的 JSON 字段与安卓壳 PlaybackService 解析的完全一致，页面只需要一个发布者。
// 封面（锁屏卡片上的那张图）由壳自己下载解码成 PixelMap，见 NowPlayingArtwork：
// 页面推上来的只是 URL，而且可能是页面自己的 blob:，壳取不到。
// 进度条拖动（onSeek）仍是缺口。

/** 页面推上来的播放快照。字段名不能改，两边壳共用同一份 wire format。 */
interface ShellPlaybackSnapshot {
  hasTrack?: boolean;
  playing?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  positionSec?: number;
  artworkUrl?: string;
}

/** 页面监听的事件名，与 web 层 services/shellNowPlaying.ts 里的常量必须一致。 */
const MEDIA_COMMAND_EVENT: string = 'folia-android-media-command';

export class PlaybackSession {
  private session: avSession.AVSession | null = null;
  private controller: webview.WebviewController | null = null;
  private context: common.UIAbilityContext | null = null;
  private backgroundAudioActive: boolean = false;
  /** 最近一次快照：封面是异步下载的，到货后要靠它把元数据重推一遍（带上封面）。 */
  private lastSnapshot: ShellPlaybackSnapshot | null = null;
  /** 当前曲目推上来的封面地址（原值）。换歌就换它，换掉时立刻丢弃旧封面。 */
  private artworkUrl: string = '';
  /** 当前曲目的封面。为 null 时元数据里不带 mediaImage（系统就画默认占位）。 */
  private artwork: image.PixelMap | null = null;

  /**
   * 建会话。必须在 Ability 的 context 上建，且一条应用只建一次。
   *
   * 会话要先于播放建起来：鸿蒙上「后台还能出声」是靠 audioPlayback 长时任务撑的
   * （module.json5 里已经声明），而长时任务要求应用有活跃的媒体会话。
   */
  async start(context: common.UIAbilityContext): Promise<void> {
    if (this.session !== null) {
      return;
    }
    this.context = context;

    const created = await avSession.createAVSession(context, 'FoliaPlayback', 'audio');
    created.setAVMetadata({
      assetId: '',
      title: 'Folia',
      artist: '',
    });
    created.setAVPlaybackState({
      state: avSession.PlaybackState.PLAYBACK_STATE_INITIAL,
    });

    created.on('play', () => this.dispatchCommand('play'));
    created.on('pause', () => this.dispatchCommand('pause'));
    created.on('playNext', () => this.dispatchCommand('next'));
    created.on('playPrevious', () => this.dispatchCommand('prev'));

    created.activate().catch((reason: BusinessError) => {
      console.warn(`[PlaybackSession] activate failed: ${reason.message}`);
    });
    this.session = created;
    console.info('[PlaybackSession] AVSession ready');
  }

  /**
   * 页面就绪后把 WebviewController 交给会话，系统上的按键才有地方可送。
   * 在此之前收到的指令直接丢弃 —— 页面还没跑起来，没有人能执行它。
   */
  attachController(controller: webview.WebviewController): void {
    this.controller = controller;
  }

  /** 桥的入口：页面每推一次快照就调一次（约 1 秒一次，见 web 层注释）。 */
  applySnapshotJson(json: string): void {
    if (this.session === null) {
      return;
    }

    let snapshot: ShellPlaybackSnapshot;
    try {
      snapshot = JSON.parse(json) as ShellPlaybackSnapshot;
    } catch (malformed) {
      console.warn('[PlaybackSession] snapshot is not JSON, ignored');
      return;
    }

    const hasTrack: boolean = snapshot.hasTrack === true;
    if (!hasTrack) {
      // 没有曲目：清空元数据并退回 STOP，卡片随之消失（安卓壳是 stopForeground + stopSelf）。
      this.lastSnapshot = null;
      this.artworkUrl = '';
      this.artwork = null;
      this.session.setAVMetadata({
        assetId: '',
        title: '',
        artist: '',
      }).catch(() => undefined);
      this.session.setAVPlaybackState({
        state: avSession.PlaybackState.PLAYBACK_STATE_STOP,
      }).catch(() => undefined);
      this.stopBackgroundAudio();
      return;
    }

    const playing: boolean = snapshot.playing === true;
    const positionSec: number = snapshot.positionSec ?? 0;

    this.lastSnapshot = snapshot;

    // 换歌就换封面：先把旧封面丢掉（宁可这一帧没有封面，也不要让锁屏显示上一首的图），
    // 再异步下载新的；到货时 pushMetadata 会带封面重推一次。
    const artworkUrl: string = snapshot.artworkUrl ?? '';
    if (artworkUrl !== this.artworkUrl) {
      this.artworkUrl = artworkUrl;
      this.artwork = null;
      this.loadArtwork(artworkUrl);
    }

    this.pushMetadata(snapshot);

    this.session.setAVPlaybackState({
      state: playing
        ? avSession.PlaybackState.PLAYBACK_STATE_PLAY
        : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
      speed: playing ? 1 : 0,
      // 系统拿这个 (位置, 时间戳) 自己外推进度，所以页面不必按帧推快照。
      position: {
        elapsedTime: Math.max(0, positionSec) * 1000,
        updateTime: Date.now(),
      },
    }).catch((reason: BusinessError) => {
      console.warn(`[PlaybackSession] setAVPlaybackState failed: ${reason.message}`);
    });

    if (playing) {
      this.startBackgroundAudio();
    }
  }

  /** 把元数据（标题、艺人、专辑、时长，有封面时连封面一起）下发给系统。 */
  private pushMetadata(snapshot: ShellPlaybackSnapshot): void {
    const session = this.session;
    if (session === null) {
      return;
    }
    const title: string = snapshot.title ?? '';
    const artist: string = snapshot.artist ?? '';
    const album: string = snapshot.album ?? '';
    const durationSec: number = snapshot.durationSec ?? 0;

    const metadata: avSession.AVMetadata = {
      // assetId 只是给系统去重的键：同一首歌重复推快照不该让卡片闪一下。
      assetId: `${title}|${artist}`,
      title: title,
      artist: artist,
      album: album,
      // AVMetadata 的时长是毫秒，快照给的是整秒。
      duration: Math.max(0, durationSec) * 1000,
    };
    if (this.artwork !== null) {
      metadata.mediaImage = this.artwork;
    }

    session.setAVMetadata(metadata).catch((reason: BusinessError) => {
      console.warn(`[PlaybackSession] setAVMetadata failed: ${reason.message}`);
    });
  }

  /**
   * 下载并解码当前曲目的封面，到货后重推一次元数据。
   *
   * 全程不阻塞快照处理：封面是装饰，慢一步没关系；失败就保持没有封面。
   * 到货时再确认一次地址没变 —— 期间可能已经切歌了，那样这张图要丢掉。
   */
  private loadArtwork(url: string): void {
    if (url.length === 0) {
      return;
    }
    NowPlayingArtwork.load(url).then((pixelMap: image.PixelMap | null) => {
      if (pixelMap === null) {
        return;
      }
      if (this.artworkUrl !== url) {
        // 已经换歌了：这张图不属于当前曲目，直接丢掉（缓存里还留着，回头还能命中）。
        return;
      }
      this.artwork = pixelMap;
      const snapshot = this.lastSnapshot;
      if (snapshot !== null) {
        this.pushMetadata(snapshot);
      }
      ShellLog.info('lock screen artwork attached');
    }).catch((reason: BusinessError) => {
      ShellLog.warn(`lock screen artwork skipped: ${reason.message}`);
    });
  }

  /** 把系统上的按键送回页面：与安卓壳 MainActivity 派发的是同一个事件名、同一份 detail。 */
  private dispatchCommand(command: string): void {
    const controller = this.controller;
    if (controller === null) {
      console.info(`[PlaybackSession] no page yet, dropped: ${command}`);
      return;
    }

    const script = `window.dispatchEvent(new CustomEvent('${MEDIA_COMMAND_EVENT}',`
      + `{detail:{"command":"${command}"}}))`;
    try {
      controller.runJavaScript(script).catch((reason: BusinessError) => {
        console.warn(`[PlaybackSession] runJavaScript failed: ${reason.message}`);
      });
    } catch (notAttached) {
      // 页面还没挂上控制器时 runJavaScript 是同步抛错，不走 Promise 的 catch。
      console.warn('[PlaybackSession] controller not ready, command dropped');
    }
  }

  /**
   * 申请 audioPlayback 长时任务，没有它应用退到后台会被冻结、声音就断。
   * 只在真正开始播放时申请，暂停后释放 —— 常驻申请会被系统判定为滥用。
   */
  private startBackgroundAudio(): void {
    const context = this.context;
    if (this.backgroundAudioActive || context === null) {
      return;
    }
    this.backgroundAudioActive = true;

    const info: wantAgent.WantAgentInfo = {
      wants: [{
        bundleName: context.abilityInfo.bundleName,
        abilityName: context.abilityInfo.name,
      }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
    };

    wantAgent.getWantAgent(info).then((agent) => {
      backgroundTaskManager.startBackgroundRunning(
        context,
        backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK,
        agent,
      ).then(() => {
        console.info('[PlaybackSession] background audio granted');
      }).catch((reason: BusinessError) => {
        console.warn(`[PlaybackSession] background audio failed: ${reason.message}`);
      });
    }).catch((reason: BusinessError) => {
      console.warn(`[PlaybackSession] wantAgent failed: ${reason.message}`);
    });
  }

  private stopBackgroundAudio(): void {
    const context = this.context;
    if (!this.backgroundAudioActive || context === null) {
      return;
    }
    this.backgroundAudioActive = false;
    backgroundTaskManager.stopBackgroundRunning(context).catch((reason: BusinessError) => {
      console.warn(`[PlaybackSession] stop background audio failed: ${reason.message}`);
    });
  }

  /** 退出时释放。 */
  async stop(): Promise<void> {
    this.stopBackgroundAudio();
    this.controller = null;
    if (this.session === null) {
      return;
    }
    const session = this.session;
    this.session = null;
    await session.destroy();
  }
}

/**
 * 模块级单例：Ability 建会话、页面交控制器，两边必须是同一个对象。
 * ArkTS 的页面组件与 Ability 生命周期不重合，靠构造参数传递会变成两个会话。
 */
export const playbackSession: PlaybackSession = new PlaybackSession();
