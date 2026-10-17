import { describe, expect, it } from 'vitest';
import {
    clampPonderTouchButtonPosition,
    defaultPonderTouchButtonPosition,
    PONDER_TOUCH_BUTTON_EDGE_PX,
    PONDER_TOUCH_BUTTON_SIZE_PX,
    parsePonderTouchButtonPosition,
    serializePonderTouchButtonPosition,
} from '@/utils/ponder/ponderTouchButtonPosition';

// test/unit/ponder/ponderTouchButtonPosition.test.ts
// 拖动位置的钳位与序列化。要守住的两条：坐标永远不会把按钮推出视口，
// 读坏的存档只退回 null（回到右上角），不会抛。

const LANDSCAPE = { width: 816, height: 377 };
const PORTRAIT = { width: 377, height: 816 };

describe('ponderTouchButtonPosition', () => {
    it('默认落在右上角，离边 20px', () => {
        expect(defaultPonderTouchButtonPosition(LANDSCAPE)).toEqual({
            x: LANDSCAPE.width - PONDER_TOUCH_BUTTON_SIZE_PX - 20,
            y: 20,
        });
    });

    it('钳位把越界坐标拉回可视区域且留出贴边余量', () => {
        expect(clampPonderTouchButtonPosition({ x: -400, y: -400 }, LANDSCAPE)).toEqual({
            x: PONDER_TOUCH_BUTTON_EDGE_PX,
            y: PONDER_TOUCH_BUTTON_EDGE_PX,
        });
        expect(clampPonderTouchButtonPosition({ x: 9999, y: 9999 }, LANDSCAPE)).toEqual({
            x: LANDSCAPE.width - PONDER_TOUCH_BUTTON_SIZE_PX - PONDER_TOUCH_BUTTON_EDGE_PX,
            y: LANDSCAPE.height - PONDER_TOUCH_BUTTON_SIZE_PX - PONDER_TOUCH_BUTTON_EDGE_PX,
        });
    });

    it('竖屏存档搬到横屏时不会甩出屏幕', () => {
        const dropped = { x: 300, y: 900 };
        const clamped = clampPonderTouchButtonPosition(
            parsePonderTouchButtonPosition(serializePonderTouchButtonPosition(dropped))!,
            LANDSCAPE,
        );
        expect(clamped.x).toBeLessThanOrEqual(LANDSCAPE.width);
        expect(clamped.y).toBeLessThanOrEqual(LANDSCAPE.height);
    });

    it('视口比按钮还小时退到贴边余量，不返回负数', () => {
        const tiny = clampPonderTouchButtonPosition({ x: 500, y: 500 }, { width: 10, height: 10 });
        expect(tiny).toEqual({ x: PONDER_TOUCH_BUTTON_EDGE_PX, y: PONDER_TOUCH_BUTTON_EDGE_PX });
        // 默认位置在同一个退化视口里也必须退到同一点，而不是算出一个负的 x。
        expect(defaultPonderTouchButtonPosition({ width: 0, height: 0 })).toEqual({
            x: PONDER_TOUCH_BUTTON_EDGE_PX,
            y: PONDER_TOUCH_BUTTON_EDGE_PX,
        });
    });

    it('非有限数按贴边余量处理', () => {
        expect(clampPonderTouchButtonPosition({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, LANDSCAPE)).toEqual({
            x: PONDER_TOUCH_BUTTON_EDGE_PX,
            y: PONDER_TOUCH_BUTTON_EDGE_PX,
        });
    });

    it('序列化往返保持整数坐标', () => {
        const raw = serializePonderTouchButtonPosition({ x: 120.4, y: 88.6 });
        expect(raw).toBe('120,89');
        expect(parsePonderTouchButtonPosition(raw)).toEqual({ x: 120, y: 89 });
    });

    it('读不出来的存档退回 null', () => {
        expect(parsePonderTouchButtonPosition(null)).toBeNull();
        expect(parsePonderTouchButtonPosition('')).toBeNull();
        expect(parsePonderTouchButtonPosition('120')).toBeNull();
        expect(parsePonderTouchButtonPosition('120,88,4')).toBeNull();
        expect(parsePonderTouchButtonPosition('left,top')).toBeNull();
        expect(parsePonderTouchButtonPosition('NaN,12')).toBeNull();
    });

    it('竖屏与横屏的默认位置都贴着右上角', () => {
        expect(defaultPonderTouchButtonPosition(PORTRAIT).y).toBe(20);
        expect(defaultPonderTouchButtonPosition(PORTRAIT).x)
            .toBe(PORTRAIT.width - PONDER_TOUCH_BUTTON_SIZE_PX - 20);
    });
});
