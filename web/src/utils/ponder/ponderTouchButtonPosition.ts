// src/utils/ponder/ponderTouchButtonPosition.ts
// 触屏上那颗「思索」浮动按钮被拖到哪儿了。纯坐标 ↔ 字符串，localStorage 的调用留在 store 里。
//
// 位置存的是视口左上角起算的 CSS px，不是百分比，也不是「离最近那条边多少」：这颗按钮是
// 单指拖出来的整数坐标，存成屏幕比例之后，换一次分辨率就得猜它原本贴的是哪条边。
// 越界的钳位每次都重算 —— 存进去的坐标是在当时的视口里合法的，现在这个视口不一定还认。

/** 按钮的边长，和组件里的 h-12 w-12 是同一个 48。 */
export const PONDER_TOUCH_BUTTON_SIZE_PX = 48;

/**
 * 贴边留的余量。触摸目标不能顶着屏幕边缘：手势条和系统返回手势都从那里起手。
 */
export const PONDER_TOUCH_BUTTON_EDGE_PX = 8;

/** 右上角默认落点离屏幕边缘的距离，等于原来的 right-5 / top-5（1.25rem）。 */
export const PONDER_TOUCH_BUTTON_DEFAULT_INSET_PX = 20;

/** 拖动阈值：手指移动不足这么远的那一下仍然算「按下」，不算「拖」。 */
export const PONDER_TOUCH_BUTTON_DRAG_THRESHOLD_PX = 6;

export type PonderTouchButtonPosition = { x: number; y: number };

export type PonderTouchButtonViewport = { width: number; height: number };

const finiteOr = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;

const clampAxis = (value: number, extent: number): number => {
    const max = Math.max(PONDER_TOUCH_BUTTON_EDGE_PX, extent - PONDER_TOUCH_BUTTON_SIZE_PX - PONDER_TOUCH_BUTTON_EDGE_PX);
    return Math.min(Math.max(PONDER_TOUCH_BUTTON_EDGE_PX, value), max);
};

/** 把一个坐标钳进当前视口。视口比按钮还小时退到左上角余量，不返回负数。 */
export const clampPonderTouchButtonPosition = (
    position: PonderTouchButtonPosition,
    viewport: PonderTouchButtonViewport,
): PonderTouchButtonPosition => ({
    x: Math.round(clampAxis(finiteOr(position.x, PONDER_TOUCH_BUTTON_EDGE_PX), finiteOr(viewport.width, 0))),
    y: Math.round(clampAxis(finiteOr(position.y, PONDER_TOUCH_BUTTON_EDGE_PX), finiteOr(viewport.height, 0))),
});

/** 没拖过的时候按钮停在右上角，和它一直以来的位置一致。 */
export const defaultPonderTouchButtonPosition = (
    viewport: PonderTouchButtonViewport,
): PonderTouchButtonPosition => clampPonderTouchButtonPosition({
    x: viewport.width - PONDER_TOUCH_BUTTON_DEFAULT_INSET_PX - PONDER_TOUCH_BUTTON_SIZE_PX,
    y: PONDER_TOUCH_BUTTON_DEFAULT_INSET_PX,
}, viewport);

const SEPARATOR = ',';

/**
 * 读回上次拖到的位置。读坏了返回 null，让调用方退回默认位置 —— 拖丢了只是回到右上角，
 * 而这个按钮本身仍然在。
 */
export const parsePonderTouchButtonPosition = (
    raw: string | null | undefined,
): PonderTouchButtonPosition | null => {
    if (!raw) {
        return null;
    }
    const parts = raw.split(SEPARATOR);
    if (parts.length !== 2) {
        return null;
    }
    const x = Number.parseFloat(parts[0]);
    const y = Number.parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
};

export const serializePonderTouchButtonPosition = (position: PonderTouchButtonPosition): string =>
    `${Math.round(position.x)}${SEPARATOR}${Math.round(position.y)}`;
