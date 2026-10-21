import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { isNarrowViewport } from './bravaisSeamLevel';
import type { bravaisPopMotion } from './bravaisSeamMotion';
// 底部面板的样式跟着组件走：原先只写在 bravaisCollection.css 里，首页打开这条菜单时没有那套规则，
// 面板会落在视口之外（见 bravaisMenuSheet.css 的文件头）。
import './bravaisMenuSheet.css';

// src/library/suites/bravais/BravaisSeamMenuSheet.tsx
// 缝里的「⋯」菜单（集合层的「⋯ 更多」与首页工具格共用）。
//
// 宽视口照旧从按钮行上方弹出；**手机横屏（窄视口）改成从屏幕底部升起的面板**。
// 为什么：窄视口上缝本身只有 300px（BRAVAIS_SEAM_FULL_WIDTH），从缝里弹出的菜单会往墙上伸出两百多像素。
// 用户实测「点进歌单后封面显示不全」——量出来的菜单是 241×92、x 从 285 到 526，正好压在墙中央那张封面上。
//
// 面板用 portal 挂到 `document.body`，**不能**挂在 stage 根节点上：`.lattice-root` 带 `isolation: isolate`，
// 它自己就是一个层叠上下文，而它在应用外壳里是按 DOM 顺序画的（z-index: auto）——库里任何带 z-index 的
// 元素都整块压在 stage 之上，面板里的 z-index 再大也出不去。手机上「点开菜单只有屏幕变暗、面板什么都没有」
// 就是这条：底部播放条是 `absolute z-60`（FloatingPlayerControls），面板（bottom: 10px，高 101px）恰好整个
// 落在它后面；遮罩也一起被压住，所以只看得见「屏幕暗了」。挂到 body 后用一个 fixed 的宿主层顶住层级
// （见 bravaisCollection.css 的 .bravais-seam-sheet-host），遮罩与面板都在这层里，二者不可能再被拆开。
//
// 两条约束：菜单的 DOM 标记（data-bravais-seam-menu / role / data-bravais-seam-action）保持不变，用例按它找；
// 事件照旧按 React 树冒泡（portal 不改变这一点），所以缝上的 onKeyDown（Esc 收起）仍然收得到菜单里的按键。
// 但文档级的「点别处收起」是 DOM 监听，挂出去之后菜单不再在锚点里——两个调用方都补了一条
// `closest('[data-bravais-seam-menu]')` 的例外。

type BravaisSeamMenuProps = {
    open: boolean;
    /** 首页工具格的菜单另有样式（is-home）。 */
    isHome?: boolean;
    /** 宽视口的弹出动画（bravaisPopMotion 的返回值）。 */
    pop: ReturnType<typeof bravaisPopMotion>;
    /** 窄视口上面板自己的进场动画参数。 */
    reduced?: boolean;
    ariaLabel?: string;
    children: React.ReactNode;
};

/**
 * 面板走「底部升起」还是「贴着按钮弹出」。
 *
 * 除了窄视口，**很矮的视口也算**：手机横屏是 823×374（dpr 3.5），宽度过了窄视口门槛、
 * 于是走了桌面那套「在按钮行上方弹出」的定位，量出来 rect.top = -240 —— 一个 232px 高的面板
 * 被放到屏幕上方 240px 处，整块在视口之外。用户看到的就是「点 ⋯ 什么都没出现」。
 */
const useSheetLayout = (): boolean => {
    const [sheet, setSheet] = useState(() => typeof window !== 'undefined'
        && (isNarrowViewport(window.innerWidth) || window.innerHeight <= 500));
    useEffect(() => {
        const update = () => setSheet(typeof window !== 'undefined'
            && (isNarrowViewport(window.innerWidth) || window.innerHeight <= 500));
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);
    return sheet;
};

/**
 * 面板的挂载点：`document.body`。
 *
 * 只用 body，不查 `[data-library-stage="bravais"]`：stage 带 `isolation: isolate`，整块在应用外壳里按 DOM
 * 顺序作画，底部播放条（z-60）压在它上面，面板就跟着被压在下面（见文件头）。挂到 body 之后再套一层
 * 定级 fixed 宿主，层级只由那一层决定。
 */
const sheetHost = (): HTMLElement | null => (typeof document === 'undefined' ? null : document.body);

export const BravaisSeamMenu: React.FC<BravaisSeamMenuProps> = ({ open, isHome, pop, reduced = false, ariaLabel, children }) => {
    const narrow = useSheetLayout();
    const host = narrow ? sheetHost() : null;
    const className = `bravais-seam-menu${isHome ? ' is-home' : ''}${narrow ? ' is-sheet' : ''}`;
    // 窄视口从底部升起：位移小、时长与宽视口的弹出同一档（bravaisPopMotion 的量级）。
    const sheetMotion = narrow ? {
        initial: reduced ? { opacity: 0 } : { opacity: 0, y: 24 },
        animate: { opacity: 1, y: 0, pointerEvents: 'auto' as const },
        exit: reduced ? { opacity: 0 } : { opacity: 0, y: 24 },
        transition: { duration: reduced ? 0 : 0.18 },
    } : pop;
    const menu = (
        <AnimatePresence>
            {open && (
                <motion.div key="menu" className={className} role="menu" aria-label={ariaLabel}
                    data-bravais-seam-menu data-bravais-seam-menu-sheet={narrow ? 'true' : undefined} {...sheetMotion}>
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
    if (!host) return menu;
    // 宿主层一直挂着（pointer-events: none，遮罩只在打开时渲染），这样收起时面板还能放完退场动画。
    return createPortal(
        <div className="bravais-seam-sheet-host" data-bravais-seam-menu-host>
            {open && <div className="bravais-seam-menu-scrim" data-bravais-seam-menu-scrim aria-hidden />}
            {menu}
        </div>,
        host,
    );
};
