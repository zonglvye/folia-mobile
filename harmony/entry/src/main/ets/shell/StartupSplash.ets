import { display } from '@kit.ArkUI';

// harmony/entry/src/main/ets/shell/StartupSplash.ets
// 原生启动动画：盖在 ArkWeb 上面的一层，从 App 起来的第一帧就开始放，
// 等页面报「第一帧画完了」再退场。放在这一层而不是页面里的原因：
// 页面自己的首屏遮罩要等 index.html + JS bundle 解析完才可能出现，
// 在那之前屏幕上只有 window 底色 —— 冷启动时这段空白就是「闪一下黑」的全部来源。
//
// 三段时间：
//   1. 入场（0–1.15s）：Folia 五个字母从模糊/下坠里对上焦，下面浮起一排骨相波。
//   2. 停留：动画放完但页面还没好时，波形继续呼吸，不会「放完就卡住」。
//   3. 退场（300ms）：整体推近 + 淡出，露出下面已经画好的界面。
//
// 退场的触发条件是「页面第一帧画好了」（web 侧 AppSplashGate → 桥的 splashReady），
// 但有下限（最短展示时长，否则动画还没看完就被切走）和上限（兜底，页面永不报也要让用户进去）。

/** 字母逐字浮现的错拍与时长。 */
const LETTER_STAGGER_MS: number = 55;
const LETTER_INTRO_MS: number = 620;
const LETTER_INTRO_START_MS: number = 80;
const BARS_INTRO_AT_MS: number = 420;
const BARS_FADE_MS: number = 200;
const EXIT_MS: number = 300;

/** 最短展示：动画至少完整放一遍，否则冷启动看起来像闪了一下。 */
export const SPLASH_MIN_VISIBLE_MS: number = 1150;
/** 兜底上限：页面一直不报 ready（例如换了旧 web 包）也必须能进去。 */
export const SPLASH_MAX_VISIBLE_MS: number = 2600;

const LETTERS: string[] = ['F', 'o', 'l', 'i', 'a'];
const BAR_COUNT: number = 13;

@Component
export struct StartupSplash {
  /** 页面第一帧是否已经画好（壳桥 splashReady 写进 AppStorage）。 */
  @Prop @Watch('onReadyChanged') ready: boolean = false;
  /** 父级记下的启动时刻（Date.now()），用来算最短展示还剩多久。 */
  startAt: number = 0;
  /** 退场动画结束、可以从组件树上摘掉时回调。 */
  onFinish: () => void = () => {};

  // ---- 动画量：全部以 vp / 0–1 表示，初值就是「入场前」的状态 ----
  @State letterOpacity: number[] = [0, 0, 0, 0, 0];
  @State letterShift: number[] = [22, 22, 22, 22, 22];
  @State letterScale: number[] = [0.94, 0.94, 0.94, 0.94, 0.94];
  @State barOpacity: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  @State barScale: number[] = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  @State exitOpacity: number = 1;
  @State exitScale: number = 1;

  // ---- 每根波形的随机参数（不参与渲染状态，只喂给 animateTo） ----
  private barPeaks: number[] = [];
  private barDurations: number[] = [];

  // ---- 算出来的布局尺寸 ----
  private wordmarkSize: number = 140;
  private letterGap: number = 8;
  private waveHeight: number = 62;
  private barGap: number = 9;
  private barWidths: number[] = [];
  private contentGap: number = 26;

  private readonly letterIndexes: number[] = [0, 1, 2, 3, 4];
  private readonly barIndexes: number[] =
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  private timers: number[] = [];
  private exiting: boolean = false;

  aboutToAppear(): void {
    this.measure();
    this.seedWave();
    // 40ms 的错拍：让窗口底色先出一帧，动画的第一帧不会和启动窗口的切换撞在一起。
    this.after(40, () => { this.playIntro(); });
    this.after(SPLASH_MAX_VISIBLE_MS, () => { this.beginExit(); });
  }

  aboutToDisappear(): void {
    for (const id of this.timers) {
      clearTimeout(id);
    }
    this.timers = [];
  }

  /** 按真实屏幕宽度换算尺寸；拿不到屏幕信息时退回 823（真机横屏宽度）。 */
  private measure(): void {
    let width = 823;
    try {
      const info = display.getDefaultDisplaySync();
      if (info.densityPixels > 0) {
        width = info.width / info.densityPixels;
      }
    } catch (error) {
      width = 823;
    }
    this.wordmarkSize = Math.min(200, Math.max(56, width * 0.17));
    // 字母之间不再加间距：各字的自然边距就是排版间距，才像一句话而不是五个字。
    this.letterGap = 0;
    this.waveHeight = Math.min(96, Math.max(40, width * 0.08));
    this.barGap = Math.min(11, Math.max(6, width * 0.011));
    this.contentGap = Math.min(26, Math.max(14, this.waveHeight * 0.30));
  }

  /** 波形：中间高两端低的包络再叠随机，和页面里那套是同一个味道，但不必一模一样。 */
  private seedWave(): void {
    const peaks: number[] = [];
    const durations: number[] = [];
    const widths: number[] = [];
    const floors: number[] = [];
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const envelope = Math.sin(((i + 0.5) / BAR_COUNT) * Math.PI);
      const peak = Math.min(1, 0.34 + envelope * (0.4 + Math.random() * 0.3));
      const floor = 0.16 + Math.random() * 0.18;
      peaks.push(Number(peak.toFixed(3)));
      // 起得快一点：页面通常 1.6-2s 就报 ready，波形要在退场前至少完整走一轮。
      durations.push(Math.round(620 + Math.random() * 420));
      widths.push(Number((3.6 + Math.random() * 2.6).toFixed(2)));
      floors.push(Number(floor.toFixed(3)));
    }
    this.barPeaks = peaks;
    this.barDurations = durations;
    this.barWidths = widths;
    this.barScale = floors;
  }

  private after(ms: number, task: () => void): void {
    const id = setTimeout(() => {
      task();
    }, ms);
    this.timers.push(id);
  }

  /** 入场：字母逐字对上焦，波形晚半拍立起来。 */
  private playIntro(): void {
    for (let i = 0; i < LETTERS.length; i += 1) {
      this.getUIContext().animateTo({
        duration: LETTER_INTRO_MS,
        delay: LETTER_INTRO_START_MS + i * LETTER_STAGGER_MS,
        curve: Curve.Friction,
      }, () => {
        this.letterOpacity[i] = 1;
        this.letterShift[i] = 0;
        this.letterScale[i] = 1;
      });
    }

    this.after(BARS_INTRO_AT_MS, () => {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        this.getUIContext().animateTo({ duration: BARS_FADE_MS, delay: i * 12, curve: Curve.Friction }, () => {
          this.barOpacity[i] = 1;
        });
      }
    });

    // 呼吸：无限交替。放在淡入之后再起，否则第一轮会从「一根线」直接窜到峰值。
    this.after(BARS_INTRO_AT_MS + 100, () => {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        this.getUIContext().animateTo({
          duration: this.barDurations[i],
          // 一起起步（只留 6ms 的错拍），靠各自不同的周期自然散开；
          // 随机延迟会让后几根在退场前还没动过，波形看起来像没起来。
          delay: i * 6,
          iterations: -1,
          playMode: PlayMode.Alternate,
          curve: Curve.EaseInOut,
        }, () => {
          this.barScale[i] = this.barPeaks[i];
        });
      }
    });
  }

  /** 页面报 ready 了：到最短展示时长就退场，到得早就等一等。 */
  private onReadyChanged(): void {
    if (!this.ready) {
      return;
    }
    const elapsed = Date.now() - this.startAt;
    const wait = elapsed >= SPLASH_MIN_VISIBLE_MS ? 0 : SPLASH_MIN_VISIBLE_MS - elapsed;
    this.after(wait, () => { this.beginExit(); });
  }

  /** 退场只跑一次：上限兜底和 ready 可能同时到。 */
  private beginExit(): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    this.getUIContext().animateTo({ duration: EXIT_MS, curve: Curve.EaseIn }, () => {
      this.exitOpacity = 0;
      this.exitScale = 1.035;
    });
    this.after(EXIT_MS + 20, () => {
      this.onFinish();
    });
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 底色：与 module.json5 的 startWindowBackground 同色，系统启动窗口切过来时没有接缝。
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#070707')

      Column({ space: this.contentGap }) {
        Row({ space: this.letterGap }) {
          ForEach(this.letterIndexes, (index: number) => {
            Text(LETTERS[index])
              .fontSize(this.wordmarkSize)
              .fontWeight(700)
              .fontColor('#FFFFFF')
              .lineHeight(this.wordmarkSize)
              .textShadow({ radius: 14, color: 'rgba(255,255,255,0.42)', offsetX: 0, offsetY: 0 })
              .opacity(this.letterOpacity[index])
              .translate({ y: this.letterShift[index] })
              .scale({ x: this.letterScale[index], y: this.letterScale[index] })
          }, (index: number) => index.toString())
        }
        .alignItems(VerticalAlign.Bottom)

        Row({ space: this.barGap }) {
          ForEach(this.barIndexes, (index: number) => {
            Column()
              .width(this.barWidths[index])
              .height('100%')
              .borderRadius(this.barWidths[index] / 2)
              .backgroundColor('#FFFFFF')
              .opacity(this.barOpacity[index])
              .scale({ x: 1, y: this.barScale[index] })
              .shadow({ radius: 12, color: 'rgba(255,255,255,0.30)' })
          }, (index: number) => index.toString())
        }
        .height(this.waveHeight)
        .alignItems(VerticalAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#070707')
    .opacity(this.exitOpacity)
    .scale({ x: this.exitScale, y: this.exitScale })
  }
}
