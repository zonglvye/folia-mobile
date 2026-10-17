import { Buffer } from 'buffer';
import { ensureVisualizerFrameRateDefault, installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { isAndroidShell } from './utils/platform';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
// 手机壳上首启默认 60 帧：没有这道闸时每个 draw loop 都跟着屏幕刷新率跑，120Hz 机器上
// 可视化器和网格过场就是两倍的帧、两倍的开销。用户在图形设置里改过就永远听用户的。
if (isAndroidShell()) {
    ensureVisualizerFrameRateDefault(60);
}
installGlobalVisualizerFrameRateLimiter();

void import('./bootstrap');
