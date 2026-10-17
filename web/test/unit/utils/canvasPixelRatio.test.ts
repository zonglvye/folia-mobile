import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_PIXEL_RATIO, resolveCanvasPixelRatio } from '../../../src/utils/canvasPixelRatio';

// test/unit/utils/canvasPixelRatio.test.ts

describe('resolveCanvasPixelRatio', () => {
    it('leaves 1x and 2x screens untouched', () => {
        expect(resolveCanvasPixelRatio(1)).toBe(1);
        expect(resolveCanvasPixelRatio(1.5)).toBe(1.5);
        expect(resolveCanvasPixelRatio(2)).toBe(2);
    });

    it('caps denser screens at the shared maximum, so a 3x phone gets a 4x backing store instead of 9x', () => {
        expect(resolveCanvasPixelRatio(3)).toBe(CANVAS_MAX_PIXEL_RATIO);
        expect(resolveCanvasPixelRatio(3.5)).toBe(CANVAS_MAX_PIXEL_RATIO);
        expect(resolveCanvasPixelRatio(4)).toBe(CANVAS_MAX_PIXEL_RATIO);
    });

    it('never drops below 1 for missing, zero, negative or non-finite input', () => {
        expect(resolveCanvasPixelRatio(undefined)).toBe(1);
        expect(resolveCanvasPixelRatio(Number.NaN)).toBe(1);
        expect(resolveCanvasPixelRatio(Number.POSITIVE_INFINITY)).toBe(1);
        expect(resolveCanvasPixelRatio(0)).toBe(1);
        expect(resolveCanvasPixelRatio(0.5)).toBe(1);
        expect(resolveCanvasPixelRatio(-2)).toBe(1);
    });
});
