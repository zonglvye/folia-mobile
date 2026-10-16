// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BravaisAccount from '@/library/suites/bravais/BravaisAccount';
import { setBravaisAccountStageInteractive, useBravaisAccountStore } from '@/library/suites/bravais/bravaisAccountStore';
import type { LibraryAccountController, LibraryAccountSnapshot, LibraryAccountSurfaceProps } from '@/library/core/contracts/account';

// test/unit/library/bravais/bravaisAccountCover.test.ts
// bravais 的登录 / 切换确认画在 stage 的缝里：宿主的整页页面（模组的首页页面）盖住首页时 stage 不可交互、表单看不见，
// 首页外壳却仍可交互。这时表单的独占按键层不能装上——否则页面里打字被吞，Enter 会确认看不见的平台切换。
// 页面关掉（stage 回到可交互）后照常接管。

vi.mock('react-i18next', async importOriginal => ({
    ...(await importOriginal<typeof import('react-i18next')>()),
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: LibraryAccountSnapshot = {
    providers: [],
    activeProviderId: 'netease',
    login: null,
    pendingSwitch: { id: 7, from: 'netease', to: 'qq', reason: 'switch' },
    logout: { providerId: null, status: 'idle' },
    lastLoginCompletion: null,
} as unknown as LibraryAccountSnapshot;

const createController = () => ({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    confirmSwitch: vi.fn(async () => ({ status: 'confirmed' })),
    cancelSwitch: vi.fn(() => ({ status: 'cancelled' })),
    closeLogin: vi.fn(() => ({ status: 'closed' })),
}) as unknown as LibraryAccountController & {
    confirmSwitch: ReturnType<typeof vi.fn>;
    cancelSwitch: ReturnType<typeof vi.fn>;
};

describe('bravais account form under a host page', () => {
    let root: Root | null = null;

    afterEach(() => {
        act(() => root?.unmount());
        root = null;
        act(() => setBravaisAccountStageInteractive(false));
        document.body.replaceChildren();
    });

    const render = (account: LibraryAccountController) => {
        const props = {
            account,
            theme: {},
            isDaylight: false,
            // Home 交给账户宿主的是首页外壳的可交互标记：页面开着时它仍为 true。
            isInteractive: true,
            declaredActions: { actions: [] },
            layer: { getElement: () => null, subscribe: () => () => {} },
        } as unknown as LibraryAccountSurfaceProps;
        root = createRoot(document.body.appendChild(document.createElement('div')));
        act(() => root!.render(React.createElement(BravaisAccount, props)));
    };

    /** 模组页面里的一个输入框（ShadowRoot 里），在它上面按一个键，返回事件与输入框自己收到的键。 */
    const pressInPage = (key: string) => {
        const host = document.body.appendChild(document.createElement('section'));
        const input = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('textarea'));
        const received: string[] = [];
        input.addEventListener('keydown', event => received.push(event.key));
        const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
        input.dispatchEvent(event);
        host.remove();
        return { event, received };
    };

    it('leaves keys to the page while the stage that draws the form is covered', () => {
        const account = createController();
        act(() => setBravaisAccountStageInteractive(false));
        render(account);
        expect(useBravaisAccountStore.getState().form?.kind).toBe('confirm');
        // 缝也不再声明接管键盘（hasBlockingWindow 不因看不见的表单让路）。
        expect(useBravaisAccountStore.getState().isInteractive).toBe(false);

        const typed = pressInPage('a');
        expect(typed.event.defaultPrevented).toBe(false);
        expect(typed.received).toEqual(['a']);
        const enter = pressInPage('Enter');
        expect(enter.received).toEqual(['Enter']);
        expect(account.confirmSwitch).not.toHaveBeenCalled();
        pressInPage('Escape');
        expect(account.cancelSwitch).not.toHaveBeenCalled();
    });

    it('takes the keys again once the page closes and the stage is interactive', () => {
        const account = createController();
        act(() => setBravaisAccountStageInteractive(false));
        render(account);
        act(() => setBravaisAccountStageInteractive(true));
        expect(useBravaisAccountStore.getState().isInteractive).toBe(true);

        const typed = pressInPage('a');
        expect(typed.event.defaultPrevented).toBe(true);
        expect(typed.received).toEqual([]);
        pressInPage('Enter');
        expect(account.confirmSwitch).toHaveBeenCalledWith(7);
    });
});
