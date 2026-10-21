import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildServiceStubModule, LOCAL_MUSIC_SERVICE_ROUTE } from '../../dev/probes/homeBehavior/serviceStubModule';
import '../../dev/probes/homeBehavior/probeApi';

// test/component/bravaisSeamMenuSheet.spec.ts
// 「⋯」菜单在两种视口下的开法（2026-10 用户实测：手机上点进歌单后，从缝里弹出的菜单压住了墙中央那张封面，
// 叫「显示不全」）。量的结果是菜单 241×92、x 从 285 到 526，而缝只有 300px、墙只有 516px。
//
// 窄视口（≤ 900，与 BRAVAIS_NARROW_VIEWPORT_PX 同一个门槛）：菜单是挂在 stage 根节点上的底部面板 ——
// 贴屏幕底、定宽居中、压一层遮罩，点遮罩收起。宽视口照旧从按钮行上方弹出，不挂 portal、不铺遮罩。

const PHONE = { width: 816, height: 377 } as const;
const DESKTOP = { width: 1440, height: 1100 } as const;

const stage = (page: Page) => page.locator('[data-library-stage="bravais"]');
const seam = (page: Page) => page.locator('[data-bravais-seam]');
const menu = (page: Page) => page.locator('[data-bravais-seam-menu]');
const settled = (page: Page) => expect(stage(page)).not.toHaveAttribute('data-bravais-settling', /.*/, { timeout: 10_000 });

/** 一张此刻完整在视口里、没被缝盖住的首页卡片（窄矮视口上不能沿用「屏幕中部」那套判断）。 */
const visibleCardSlot = (page: Page) => page.evaluate(() => {
    const seamRect = document.querySelector('[data-bravais-seam]')?.getBoundingClientRect();
    const fits = (rect: DOMRect) => rect.width > 40 && rect.height > 40
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && (!seamRect || seamRect.width < 1 || rect.right < seamRect.left - 4 || rect.left > seamRect.right + 4);
    const tile = [...document.querySelectorAll<HTMLElement>('.bravais-tile[data-library-card]')]
        .find(element => fits(element.getBoundingClientRect()));
    return tile?.dataset.bravaisSlot ?? null;
});

/** 首页 → 点开一张卡片进集合 → 打开「⋯」菜单。 */
const openCollectionMenu = async (
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

    await seam(page).locator('[data-bravais-seam-action="more"]').click();
    await expect(menu(page)).toBeVisible();
    // 出场动画放完再量：面板初始带 y 位移。
    await page.waitForTimeout(400);
};

test.describe('[bravais-only] the 「⋯」 menu', () => {
    test('on a phone it rises from the bottom of the screen, with a scrim, outside the seam', async ({ mount, page }) => {
        await openCollectionMenu(mount, page, PHONE);

        await expect(menu(page)).toHaveAttribute('data-bravais-seam-menu-sheet', 'true');
        // 挂在 body 上、不在缝里也不在 stage 根节点上：stage 带 isolation: isolate，整块按 DOM 顺序画，
        // 库里带 z-index 的元素（底部播放条 z-60）压得住它里面的任何层级 —— 面板会被整个盖掉。
        await expect(seam(page).locator('[data-bravais-seam-menu]')).toHaveCount(0);
        await expect(stage(page).locator('[data-bravais-seam-menu]')).toHaveCount(0);
        await expect(page.locator('[data-bravais-seam-menu-host] [data-bravais-seam-menu]')).toHaveCount(1);
        await expect(page.locator('[data-bravais-seam-menu-scrim]')).toHaveCount(1);

        // 宿主层是 body 的直接子节点，且层级高过底部播放条（FloatingPlayerControls 的 z-60）。
        const hostStacking = await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('[data-bravais-seam-menu-host]');
            return {
                parent: host?.parentElement?.tagName ?? null,
                z: host ? Number.parseInt(getComputedStyle(host).zIndex, 10) : Number.NaN,
            };
        });
        expect(hostStacking.parent).toBe('BODY');
        expect(hostStacking.z).toBeGreaterThan(60);

        // 真机上的那条症状：底部播放条（FloatingPlayerControls，absolute z-60）是 stage 的兄弟节点，
        // 面板只要还在 stage 里就会被它整块盖住 —— 用户看到的就是「只有屏幕变暗，什么都没有」。
        // 这里造一个同层级的假播放条压在面板位置上，确认面板仍然在最上面（点得到）。
        const paintedAbovePlayerBar = await page.evaluate(() => {
            const shell = document.querySelector('[data-library-stage="bravais"]')?.parentElement;
            const panel = document.querySelector('[data-bravais-seam-menu]');
            if (!shell || !panel) return false;
            const bar = document.createElement('div');
            bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:120px;z-index:60;background:#123;';
            shell.appendChild(bar);
            const box = panel.getBoundingClientRect();
            const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const onTop = Boolean(at && at.closest('[data-bravais-seam-menu]'));
            bar.remove();
            return onTop;
        });
        expect(paintedAbovePlayerBar).toBe(true);

        const box = (await menu(page).boundingBox())!;
        // 贴底：面板底边离屏幕底 10px 上下（留一点行差给圆角与安全区）。
        expect(Math.abs((box.y + box.height) - (PHONE.height - 10))).toBeLessThanOrEqual(3);
        // 定宽居中：不超过 440，且左右留白相等。
        expect(box.width).toBeLessThanOrEqual(440);
        expect(Math.abs((box.x + box.width / 2) - PHONE.width / 2)).toBeLessThanOrEqual(2);
        // 面板整个在视口里（不再往墙上伸出屏幕）。
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);

        // 点遮罩收起：菜单消失，且没有触发菜单里的任何一项。
        await page.locator('[data-bravais-seam-menu-scrim]').click({ position: { x: 8, y: 8 } });
        await expect(menu(page)).toHaveCount(0);
        await expect(page.locator('[data-bravais-seam-menu-scrim]')).toHaveCount(0);
    });

    test('on a desktop it keeps popping up above the button row, with no scrim', async ({ mount, page }) => {
        await openCollectionMenu(mount, page, DESKTOP);

        await expect(menu(page)).not.toHaveAttribute('data-bravais-seam-menu-sheet', 'true');
        await expect(page.locator('[data-bravais-seam-menu-scrim]')).toHaveCount(0);
        // 仍在缝里（原地弹出，不挂 portal）。
        await expect(seam(page).locator('[data-bravais-seam-menu]')).toHaveCount(1);

        const box = (await menu(page).boundingBox())!;
        const moreButton = (await seam(page).locator('[data-bravais-seam-action="more"]').boundingBox())!;
        // 菜单底边在「⋯」按钮上方（悬浮，不推挤按钮行）。
        expect(box.y + box.height).toBeLessThanOrEqual(moreButton.y + 1);
    });
});
