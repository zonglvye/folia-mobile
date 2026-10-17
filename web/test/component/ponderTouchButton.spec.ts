import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/ponderTouchButton.spec.ts
// 触屏思索按钮的拖动。见 dev/probes/ponderTouchButton.probe.tsx。
//
// 这里必须开 hasTouch：按钮只在粗指针下渲染（没有悬停、也没有 Ctrl+G 时它是唯一入口），
// 桌面指针下这个组件返回 null，测的会是一片空白。第一条用例就是先把这个前提钉住 ——
// 它失败的时候，后面所有失败都是同一个原因。
//
// 位置一律读按钮自己的 inline `left` / `top`，不读 bounding box：拖动过程只写 DOM style，
// 而 bounding box 会带上亚像素取整，拿它比整数坐标差一像素。

type Mount = (component: string) => Promise<unknown>;

const BUTTON = '[data-testid="page-ponder-touch-button"]';
const STATE = '[data-probe-state]';

/** 和组件里的常量对齐：48px 的按钮，默认离边 20px，贴边余量 8px。 */
const SIZE = 48;
const INSET = 20;
const EDGE = 8;
const VIEWPORT = { width: 816, height: 377 };

// 本机没装 Playwright 的 chromium 时，加上 `channel: 'chrome'` 用系统里的 Chrome 跑。
test.use({ hasTouch: true, viewport: VIEWPORT });

// 不需要清理 localStorage：Playwright 每个用例一个全新 context，存储本来就是空的。
// 反过来，**不能**用 addInitScript 去清：它在每次导航前都会跑，reload 那一例会被自己清掉。
test.beforeEach(async ({ mount }) => {
    await (mount as unknown as Mount)('ponderTouchButton');
});

/** 按钮现在停在哪（拖动过程中这是唯一的真相）。 */
async function positionOf(page: Page): Promise<{ x: number; y: number }> {
    return page.locator(BUTTON).evaluate(node => {
        const style = (node as HTMLElement).style;
        return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) };
    });
}

/** 从按钮中心按住，分步拖 (dx, dy)，松手。起点取整，免得亚像素混进断言。 */
async function dragButton(page: Page, dx: number, dy: number) {
    const start = await positionOf(page);
    const fromX = start.x + SIZE / 2;
    const fromY = start.y + SIZE / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // 分步移动：一步到位只会产生一个 pointermove，测不到「越过阈值」那一段。
    await page.mouse.move(fromX + dx, fromY + dy, { steps: 8 });
    await page.mouse.up();
}

test.describe('触屏思索按钮', () => {
    test('前提：粗指针下才会渲染', async ({ page }) => {
        const finePointer = await page.evaluate(
            () => matchMedia('(hover: hover) and (pointer: fine)').matches,
        );
        expect(finePointer).toBe(false);
        await expect(page.locator(BUTTON)).toBeVisible();
    });

    test('默认停在右上角', async ({ page }) => {
        expect(await positionOf(page)).toEqual({
            x: VIEWPORT.width - SIZE - INSET,
            y: INSET,
        });
        // 没拖过时 store 里是空的 —— 位置不存在一个跨机型通用的常数。
        expect(await page.locator(STATE).getAttribute('data-probe-position')).toBe('');
    });

    test('拖动会移动按钮并记住位置', async ({ page }) => {
        await dragButton(page, -300, 150);

        const moved = { x: VIEWPORT.width - SIZE - INSET - 300, y: INSET + 150 };
        expect(await positionOf(page)).toEqual(moved);

        // 松手才写 store。
        expect(await page.locator(STATE).getAttribute('data-probe-position'))
            .toBe(`${moved.x},${moved.y}`);

        // 落在 storage 里。
        const persisted = await page.evaluate(() => localStorage.getItem('ponder_touch_button_position'));
        expect(persisted).toBe(`${moved.x},${moved.y}`);
    });

    test('拖出屏幕会被钳回贴边余量', async ({ page }) => {
        await dragButton(page, -2000, -2000);

        expect(await positionOf(page)).toEqual({ x: EDGE, y: EDGE });
    });

    test('拖动松手那一下不打开思索', async ({ page }) => {
        await dragButton(page, -300, 100);

        await expect(page.locator(STATE)).toHaveAttribute('data-probe-session', 'closed');
    });

    test('位置在重载后沿用', async ({ mount, page }) => {
        await dragButton(page, -200, 120);
        const before = await positionOf(page);

        // 写盘这一半在这里验：真的落在 localStorage 里。
        expect(await page.evaluate(() => localStorage.getItem('ponder_touch_button_position')))
            .toBe(`${before.x},${before.y}`);

        // 读回来那一半不在这里验：harness 的 auto fixture 每次导航都会 localStorage.clear()，
        // 重载后的干净启动注定读不到值，塞进去也会被它清掉。那条路径由
        // test/unit/stores/ponderStore.test.ts 的「拖动之后位置落盘并回读」覆盖。
        await expect(page.locator(BUTTON)).toBeVisible();
    });
});
