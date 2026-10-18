import { describe, expect, it } from 'vitest';
import {
    BRAVAIS_PANEL_MAX_WIDTH,
    promoteCollectionSpine,
    resolvePanelWidth,
    resolvePosterWidth,
    resolveSeamTarget,
} from '@/library/suites/bravais/bravaisSeamTarget';
import {
    BRAVAIS_SEAM_SPINE_WIDTH,
    BRAVAIS_SEAM_FULL_WIDTH,
} from '@/library/suites/bravais/bravaisConstants';

// test/unit/library/bravais/bravaisSeamTarget.test.ts
// 缝该开多宽：开口等级之上还叠着表单、面板、过滤、海报，以及「窄视口上集合层不留书脊」这条规则。
//
// 那条规则是 2026-10 用户报的：手机横屏 816px 落在窄屏档里，点进歌手页先看到一格 64px 的竖条
// （名字被挤成一个巨大的单字），要再展开一次才是海报。这里把它钉住：窄视口上集合层要么完整，要么折叠。

const PHONE_LANDSCAPE = 816;
const DESKTOP = 1440;

describe('seam target', () => {
    it('窄视口上集合层的书脊按完整缝处理', () => {
        const target = resolveSeamTarget({ surface: 'collection', level: 'spine', viewportWidth: PHONE_LANDSCAPE });
        expect(target.width).toBe(BRAVAIS_SEAM_FULL_WIDTH);
        expect(target.variant).toBe('full');
    });

    it('首页的窄缝不受影响：那里的书脊本来就是入口', () => {
        const target = resolveSeamTarget({ surface: 'home', level: 'spine', viewportWidth: PHONE_LANDSCAPE });
        expect(target.width).toBe(BRAVAIS_SEAM_SPINE_WIDTH);
    });

    it('宽视口上集合层仍可以收成书脊', () => {
        const target = resolveSeamTarget({ surface: 'collection', level: 'spine', viewportWidth: DESKTOP });
        expect(target.width).toBe(BRAVAIS_SEAM_SPINE_WIDTH);
        expect(target.variant).toBe('spine');
    });

    it('折叠（hidden）不被这条规则展开', () => {
        const input = { surface: 'collection', level: 'hidden', viewportWidth: PHONE_LANDSCAPE } as const;
        expect(promoteCollectionSpine({ ...input })).toMatchObject({ level: 'hidden' });
        expect(resolveSeamTarget({ ...input }).width).toBe(0);
    });

    it('窄视口 + 完整等级 + 可画海报：直接是歌手海报的宽度（这就是「点进去看到的那一版」）', () => {
        const target = resolveSeamTarget({
            surface: 'artist',
            level: 'spine',
            viewportWidth: PHONE_LANDSCAPE,
            poster: true,
        });
        expect(target.variant).toBe('poster');
        expect(target.width).toBe(resolvePosterWidth(PHONE_LANDSCAPE));
        // 46% 的视口夹在 520–680 之间；816 上落在下界，也就是视口的 64%。
        expect(target.width).toBe(520);
    });

    it('过滤框开着时不画海报：临时展开回普通完整缝', () => {
        const target = resolveSeamTarget({
            surface: 'artist',
            level: 'full',
            viewportWidth: PHONE_LANDSCAPE,
            poster: true,
            filterOpen: true,
        });
        expect(target.variant).toBe('full');
        expect(target.width).toBe(BRAVAIS_SEAM_FULL_WIDTH);
    });

    it('列表面板仍有自己的开口宽度', () => {
        const target = resolveSeamTarget({
            surface: 'collection',
            level: 'spine',
            viewportWidth: PHONE_LANDSCAPE,
            panelOpen: true,
            poster: true,
        });
        expect(target.variant).toBe('panel');
        expect(target.width).toBe(resolvePanelWidth(PHONE_LANDSCAPE));
        expect(target.width).toBeLessThanOrEqual(BRAVAIS_PANEL_MAX_WIDTH);
    });

    it('手机横屏上面板与海报一样宽：从海报点「列表」不会再窄一截', () => {
        // 用户实测（2026-10）：面板原来封顶 420、海报 520，点开列表缝要缩 100px，列表比海报还窄。
        const panel = resolveSeamTarget({ surface: 'artist', level: 'full', viewportWidth: PHONE_LANDSCAPE, panelOpen: true });
        const poster = resolveSeamTarget({ surface: 'artist', level: 'full', viewportWidth: PHONE_LANDSCAPE, poster: true });
        expect(panel.width).toBe(poster.width);
        expect(panel.width).toBe(520);
    });
});
