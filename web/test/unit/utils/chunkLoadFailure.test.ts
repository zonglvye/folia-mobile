import { describe, expect, it } from 'vitest';
import { isDynamicImportFailure } from '@/utils/chunkLoadFailure';

// test/unit/utils/chunkLoadFailure.test.ts
// 这条判断决定「自动重载一次」还是「显示兜底界面」，判错的代价不对称：
// 把普通异常当成 chunk 失败会导致重载成环，把 chunk 失败当普通异常则要用户自己点。

describe('isDynamicImportFailure', () => {
    it('认得出 Chromium / WebKit 的措辞', () => {
        expect(isDynamicImportFailure('Failed to fetch dynamically imported module: https://x/assets/a.js')).toBe(true);
        expect(isDynamicImportFailure('Failed to fetch dynamically imported module')).toBe(true);
    });

    it('认得出 FireFox / 旧 Safari 的措辞', () => {
        expect(isDynamicImportFailure('error loading dynamically imported module')).toBe(true);
        expect(isDynamicImportFailure('Importing a module script failed.')).toBe(true);
    });

    it('MIME 报错也算：那通常就是 404 换了个说法', () => {
        expect(isDynamicImportFailure('Expected a JavaScript module script but the server responded with a MIME type of "text/html"')).toBe(true);
    });

    it('普通异常不算', () => {
        expect(isDynamicImportFailure('TypeError: Cannot read properties of undefined')).toBe(false);
        expect(isDynamicImportFailure('NetworkError when attempting to fetch resource.')).toBe(false);
    });

    it('空值不算，且不抛', () => {
        expect(isDynamicImportFailure(null)).toBe(false);
        expect(isDynamicImportFailure(undefined)).toBe(false);
        expect(isDynamicImportFailure('')).toBe(false);
    });
});
