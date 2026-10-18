import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildServiceStubModule, LOCAL_MUSIC_SERVICE_ROUTE } from '../../dev/probes/homeBehavior/serviceStubModule';
import '../../dev/probes/homeBehavior/probeApi';

// test/component/bravaisListPanel.spec.ts
// 列表面板的开口与密度（2026-10 用户实测：「列表太窄，只露两首歌」）：
// - 缝开 min(520, 视口 − 52)。手机横屏 816px 上正好等于歌手海报的宽度（海报下界也是 520），
//   从海报点「列表」不会再缩一截；
// - 矮视口（max-height 480）上头部并成两行——‹ + 标题 + 元数据一行、过滤位一行，面包屑的层路径收起——
//   行压成单行 30px，动作行收到 28px。容量按「列表视口高度 / 行高」算：底部播放条安全区（约 116px）也在内。
//   实测 816×377 上从 3 行变成 5 行。
// 宽视口不动：竖排头部、44px 行高、面包屑的层路径照旧。
// 探针里先放一首在播的歌（setNowPlaying）：没有歌时缝只需让 20px，量出来的密度会比真机乐观。
// 几何一律读 offsetTop / offsetWidth / clientHeight，不读 getBoundingClientRect：缝的内容层带着翻转动画的
// 3D 变换，渲染框会被缩掉约 2%，量的就不是布局了。

const PHONE = { width: 816, height: 377 } as const;
const DESKTOP = { width: 1440, height: 1100 } as const;

const stage = (page: Page) => page.locator('[data-library-stage="bravais"]');
const settled = (page: Page) => expect(stage(page)).not.toHaveAttribute('data-bravais-settling', /.*/, { timeout: 10_000 });

/** 一张此刻完整在视口里、没被缝盖住的首页卡片（窄而矮的视口上不能沿用「屏幕中部」那套判断）。 */
const visibleCardSlot = (page: Page) => page.evaluate(() => {
    const seam = document.querySelector('[data-bravais-seam]')?.getBoundingClientRect();
    const fits = (rect: DOMRect) => rect.width > 40 && rect.height > 40
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && (!seam || seam.width < 1 || rect.right < seam.left - 4 || rect.left > seam.right + 4);
    const tile = [...document.querySelectorAll<HTMLElement>('.bravais-tile[data-library-card]')]
        .find(element => fits(element.getBoundingClientRect()));
    return tile?.dataset.bravaisSlot ?? null;
});

/** 面板的几何：开口宽度、行高、列表视口高度，以及头部那几块是不是同一条基线。 */
const panelMetrics = (page: Page) => page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-bravais-list]');
    const list = panel?.querySelector<HTMLElement>('.bravais-panel-list') ?? null;
    const rows = list ? [...list.querySelectorAll<HTMLElement>('[data-bravais-list-row]')] : [];
    const trail = panel?.querySelector<HTMLElement>('.bravais-seam-crumb-trail') ?? null;
    const centerY = (selector: string) => {
        const node = panel?.querySelector<HTMLElement>(selector);
        return node ? node.offsetTop + node.offsetHeight / 2 : null;
    };
    return {
        width: panel?.offsetWidth ?? 0,
        listHeight: list?.clientHeight ?? 0,
        // react-window 把行高写在行的内联样式上（CSS 压不过它）。
        rowHeight: rows[0] ? parseFloat(rows[0].style.height) : 0,
        renderedRows: rows.length,
        crumbTrail: trail ? getComputedStyle(trail).display : 'absent',
        headCenters: [
            centerY('.bravais-seam-crumbs'),
            centerY('[data-bravais-seam-title]'),
            centerY('.bravais-seam-meta'),
        ],
    };
});

/** 打开一层的列表面板：视口先定下来（缩放与 media query 都按它算），再点开一张首页卡片、点「列表」。 */
const openListPanel = async (
    mount: (id: string) => Promise<unknown>,
    page: Page,
    viewport: { width: number; height: number },
) => {
    await page.setViewportSize(viewport);
    await page.route(LOCAL_MUSIC_SERVICE_ROUTE, route => route.fulfill({ contentType: 'text/javascript', body: buildServiceStubModule() }));
    await mount('homeBehavior');
    await expect.poll(() => page.evaluate(() => window.__homeProbe?.ready() ?? false), { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => window.__homeProbe!.setSuite('bravais'));
    await expect(stage(page)).toHaveAttribute('data-bravais-layer', 'home:playlist', { timeout: 15_000 });
    await expect(page.locator('[data-library-card]').first()).toBeAttached();
    await settled(page);
    await page.evaluate(() => window.__homeProbe!.setNowPlaying('online:probe:loaded'));

    const slot = await visibleCardSlot(page);
    expect(slot).not.toBeNull();
    await page.locator(`[data-bravais-slot="${slot}"]`).locator('article').click();
    await expect(page.locator('.bravais-tile[data-library-card]')).toHaveCount(0, { timeout: 10_000 });
    await settled(page);

    await page.locator('[data-bravais-seam-action="list"]').click();
    await expect(page.locator('[data-bravais-list]')).toBeVisible();
    // 缝里的内容整条翻过来之后才量（翻转期间旧内容挂着 leaving）。
    await expect(page.locator('[data-bravais-seam][data-bravais-seam-leaving]')).toHaveCount(0);
    await settled(page);
}

test.describe('[bravais-only] list panel width and density', () => {
    test('phone landscape: the panel is as wide as the poster and the compact header leaves room for five rows', async ({ mount, page }) => {
        await openListPanel(mount, page, PHONE);
        const metrics = await panelMetrics(page);

        // 开口与海报同宽（海报下界 520），不再比海报窄。
        expect(metrics.width).toBe(520);
        // 矮视口那一档的行高（单行排版）。
        expect(metrics.rowHeight).toBe(30);
        // 头部并成两行：面包屑（含 ‹）、标题、元数据的竖直中心对得上（过滤位在它们下面一行）。
        const centers = metrics.headCenters.filter((value): value is number => value !== null);
        expect(centers).toHaveLength(3);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
        // 面包屑的层路径在这一档收起（标题就在同一行上）。
        expect(metrics.crumbTrail).toBe('none');
        // 密度：列表视口高度除以行高。底部播放条安全区已经算在内；改之前这里是 1–2 行。
        expect(metrics.renderedRows).toBeGreaterThan(0);
        expect(metrics.listHeight / metrics.rowHeight).toBeGreaterThanOrEqual(4);
        // 上界只是防呆：真把行高和头部都改坏了才会撞上。
        expect(metrics.listHeight / metrics.rowHeight).toBeLessThan(8);
    });

    test('desktop keeps the stacked header, the crumb trail and the 44px rows', async ({ mount, page }) => {
        await openListPanel(mount, page, DESKTOP);
        const metrics = await panelMetrics(page);

        expect(metrics.width).toBe(520);
        expect(metrics.rowHeight).toBe(44);
        expect(metrics.crumbTrail).not.toBe('none');
        // 竖排头部：标题与元数据在面包屑行下面，隔着一整行。
        const [crumbs, title] = metrics.headCenters;
        expect(crumbs).not.toBeNull();
        expect(title).not.toBeNull();
        expect(title! - crumbs!).toBeGreaterThan(20);
    });
});
