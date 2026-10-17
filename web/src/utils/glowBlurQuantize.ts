import { isAndroidRuntime } from './platform';

// src/utils/glowBlurQuantize.ts
// Whether the visualizers avoid asking Chromium's glyph cache for an unbounded set of glyph sizes and
// shadow radii (Lab > "Draw lyric glow on the compositor"; also the default on Android, where the
// same re-raster is what caps the visualizer at 30 fps). While it is on:
// - glows are drawn as `drop-shadow()` filters instead of text-shadows or canvas shadows (classic and
//   partita in wordGlow.ts, claddagh, fume's live line via `setCanvasTextGlow`);
// - canvas blur radii are whole pixels (`quantizeShadowBlur`);
// - text scaled by a style transform every frame gets its own compositing layer (cadenza's overlay);
// - text drawn under a zooming camera is rasterized at a bounded set of scales and placed under the
//   camera afterwards (fume's live line, fume/fumeLiveRaster.ts).
//
// A blur radius that changes every frame makes Chromium mint a new glyph strike per frame, each
// costing a 4 KiB shared-memory chunk that is never returned; on Linux that is an fd in the renderer
// and GPU process, and the renderer's soft limit of 1024 runs out after ~35 minutes of playback. The
// full story is in docs/linux-glyph-cache-fd-leak.md.
//
// On by default on Linux and on Android. Linux is where the leak ends in a frozen compositor. Android
// is where it ends in a frame rate: classic re-rasterises the shadow mask of every glowing grapheme on
// every frame, and that work sits on the raster thread, so it never shows up as a long task - it just
// drops frames. Measured on the phone this app ships to with the in-app frame HUD: with this off the
// visualizer reports p50 = p90 = p99 = 33.3 ms while `longtasks` stays at ~10 per 30 s, i.e. a locked
// 30 fps from raster, not from JS. Everywhere else the leak costs a few MB a day, which is too little
// to be worth any visual difference.

export const GLOW_BLUR_QUANTIZE_STORAGE_KEY = 'visualizer_glow_blur_quantize';

/**
 * Where drawing the halo as a compositor filter beats drawing it as a glyph shadow: Linux (a frozen
 * compositor) and Android (a lost frame every other vsync, see above).
 */
const isGlyphShadowCostlyRuntime = () => {
    if (typeof window === 'undefined') return false;
    const electronPlatform = (window as Window & { electron?: { platform?: string } }).electron?.platform;
    if (electronPlatform) return electronPlatform === 'linux';
    if (isAndroidRuntime()) return true;
    const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    return /Linux/.test(userAgent);
};

/** The stored choice, or the platform default when the user never touched the switch. */
export const readStoredGlowBlurQuantize = (): boolean => {
    try {
        const stored = localStorage.getItem(GLOW_BLUR_QUANTIZE_STORAGE_KEY);
        if (stored === 'true' || stored === 'false') return stored === 'true';
    } catch {
        // Storage blocked: fall through to the default.
    }
    return isGlyphShadowCostlyRuntime();
};

// Module-level on purpose, like the frame-rate limiter: the canvas renderers read it every frame and
// have no business subscribing to a store for it.
let glowBlurQuantized = readStoredGlowBlurQuantize();

export const isGlowBlurQuantized = () => glowBlurQuantized;

export const setGlowBlurQuantized = (enabled: boolean) => {
    glowBlurQuantized = enabled;
};

/**
 * A shadow blur radius as it should be drawn: rounded to whole pixels while the switch is on, so a
 * sweep only ever produces a bounded set of radii; untouched when it is off.
 */
export const quantizeShadowBlur = (px: number) => {
    if (!Number.isFinite(px)) return 0;
    return glowBlurQuantized ? Math.max(0, Math.round(px)) : px;
};

/**
 * Sets the glow for the text drawn next on `context`: a canvas shadow when the switch is off; while it is
 * on, the same glow as a `drop-shadow()` filter (sigma = shadowBlur / 2, and neither follows the CTM, so
 * they match to under 1/255). A shadowed glyph is cached per device size, and a text canvas under a moving
 * camera keeps asking for new ones; a filter is applied to the drawn layer and never reaches the glyph
 * cache. Undo with `clearCanvasTextGlow`, which also resets `context.filter`.
 */
export const setCanvasTextGlow = (context: CanvasRenderingContext2D, blur: number, color: string) => {
    if (!glowBlurQuantized) {
        context.shadowBlur = blur;
        context.shadowColor = color;
        return;
    }
    context.shadowBlur = 0;
    context.shadowColor = 'transparent';
    context.filter = blur > 0 ? `drop-shadow(0 0 ${blur / 2}px ${color})` : 'none';
};

export const clearCanvasTextGlow = (context: CanvasRenderingContext2D) => {
    context.shadowBlur = 0;
    context.shadowColor = 'transparent';
    if (glowBlurQuantized) context.filter = 'none';
};

const GLOW_FILTER_SIGMA = /^drop-shadow\(0 0 ([\d.]+)px /;

/**
 * `fillText` for text drawn with `setCanvasTextGlow`. While the glow is a filter, the draw is clipped to
 * the text and its glow: Chromium renders a canvas filter into a layer the size of the clip, which is the
 * whole canvas unless something narrows it, and that took fume from 120 to ~90 fps. Callers that already
 * clip each draw tightly can keep calling `fillText`.
 */
export const fillGlowText = (context: CanvasRenderingContext2D, text: string, x: number, y: number) => {
    const sigma = Number(GLOW_FILTER_SIGMA.exec(context.filter)?.[1] ?? 0);
    if (!sigma) {
        context.fillText(text, x, y);
        return;
    }
    const metrics = context.measureText(text);
    // Four sigmas: three for the blur, the rest for a camera scale down to 0.75 (the filter ignores the CTM).
    const pad = sigma * 4 + 4;
    const left = x - metrics.actualBoundingBoxLeft - pad;
    const top = y - metrics.actualBoundingBoxAscent - pad;
    context.save();
    context.beginPath();
    context.rect(
        left,
        top,
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + pad * 2,
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + pad * 2,
    );
    context.clip();
    context.fillText(text, x, y);
    context.restore();
};
