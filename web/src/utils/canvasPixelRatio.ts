/**
 * 画布后备缓冲的像素倍率。
 *
 * 3 倍屏上直接乘 devicePixelRatio 会得到 9 倍像素量，而画布开销按像素数涨：一遍填充要写 9 倍内存，
 * 合成时再传 9 倍贴图。可视化画面本身在动、带发光与模糊，2 倍和 3 倍的清晰度差别看不出来，
 * 帧时间却差一倍以上。上限取 2 与 lumiere 的既有取舍保持一致
 * （components/visualizer/lumiere/lumiereRuntimeTuning.ts 的 LUMIERE_MAX_RENDER_RESOLUTION）。
 */
export const CANVAS_MAX_PIXEL_RATIO = 2;

/**
 * 把 devicePixelRatio 钳到 1..CANVAS_MAX_PIXEL_RATIO。
 * 调用方必须用它同时算后备缓冲尺寸和 setTransform：两者取不同的值会把画面拉花。
 */
export const resolveCanvasPixelRatio = (devicePixelRatio: number | undefined): number => {
    const ratio = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
    return Math.min(CANVAS_MAX_PIXEL_RATIO, Math.max(1, ratio));
};
