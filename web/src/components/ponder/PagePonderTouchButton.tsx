import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSupportsFinePointer } from '../../hooks/useSupportsFinePointer';
import { useAppViewStore } from '../../stores/useAppViewStore';
import { usePonderStore } from '../../stores/usePonderStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { openCurrentPagePonder } from '../../services/ponder/pagePonderTarget';
import {
    clampPonderTouchButtonPosition,
    defaultPonderTouchButtonPosition,
    PONDER_TOUCH_BUTTON_DRAG_THRESHOLD_PX,
    PONDER_TOUCH_BUTTON_SIZE_PX,
    type PonderTouchButtonPosition,
    type PonderTouchButtonViewport,
} from '../../utils/ponder/ponderTouchButtonPosition';

// src/components/ponder/PagePonderTouchButton.tsx
// 触屏上代替 Ctrl+G 的入口。
//
// 默认贴在右上角，但它**可以拖**：这颗按钮是浮在整个界面之上的常驻元素，而界面右边那一列
// （集合页的列表/搜索、播放页的侧边手柄）本来就是按钮最密的地方。位置固定，它就总会在某个
// 页面上压住东西 —— 而「压住了哪一颗」取决于用户在哪个页面，这一点组件自己不可能预判。
// 所以位置交给用户：拖一次就记住（存的是视口坐标，见 utils/ponder/ponderTouchButtonPosition）。
//
// 而且它是限时的：落地或换页时露四秒说明自己在，然后自己收起来。想再叫出来就点一下它
// 周围那块热区。这条和面板手柄在触屏上的做法是同一套（UnifiedPanel 的边缘热区）：
// 触屏没有悬停，所以屏幕的角落本身就是入口。
//
// 热区不是一个真实元素，是 window 上一个 passive 监听按坐标判的。摆一个
// pointer-events-auto 的方块在按钮旁边，等于把「挡住底下的东西」这个问题原样搬到热区上。
// 热区跟着按钮走，不是钉死在右上角：按钮被拖到别处之后，右上角已经没有东西可点了。

/** 露出来之后停留多久。够读一眼，又不至于一直杵在那里。 */
const REVEAL_MS = 4000;

/** 热区的边长，px。按触摸目标给，不按视觉尺寸给；以按钮为中心外扩。 */
const HOTSPOT_SIZE_PX = 96;

type PagePonderTouchButtonProps = {
    accent: string;
    isDaylight: boolean;
};

/** 一次拖动。start 是指针落点，origin 是按钮当时的坐标。 */
type DragState = {
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    /** 越过阈值之后才置上；没置上的那一下仍然是「按下按钮」，不是拖。 */
    moved: boolean;
};

const readViewport = (): PonderTouchButtonViewport => ({
    width: window.innerWidth,
    height: window.innerHeight,
});

/** Touch-only equivalent of Ctrl+G. It deliberately has no component-target API. */
const PagePonderTouchButton: React.FC<PagePonderTouchButtonProps> = ({ accent, isDaylight }) => {
    const { t } = useTranslation();
    const isCoarsePointer = !useSupportsFinePointer();
    const hasSession = usePonderStore(state => state.session !== null);
    const isOnboardingOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);
    const showTouchButton = usePonderStore(state => state.showPonderTouchButton);
    const storedPosition = usePonderStore(state => state.ponderTouchButtonPosition);
    const setStoredPosition = usePonderStore(state => state.setPonderTouchButtonPosition);
    const view = useAppViewStore(state => state.view);

    const [isRevealed, setIsRevealed] = useState(true);
    const hideTimerRef = useRef<number | null>(null);
    // 监听器里要读当前的显隐，但它不该因为显隐变化就解绑重绑。
    const isRevealedRef = useRef(isRevealed);
    isRevealedRef.current = isRevealed;
    /**
     * 「这一下是把它叫出来的，不是按它」。
     *
     * 热区和按钮占的是同一块地方：隐藏时按钮 pointer-events-none，所以 pointerdown 落到底下，
     * 热区把它露出来；可同一次触摸的 click 是在那之后才派发的，那时按钮已经可点了，
     * 于是一下变成两件事 —— 叫出来，然后立刻进了教程。这面旗就是用来吃掉那一次 click 的。
     * 拖完手一松也走同一面旗：那一下 click 是拖动的尾巴，不是「打开思索」。
     */
    const suppressNextClickRef = useRef(false);

    const buttonRef = useRef<HTMLButtonElement | null>(null);
    /**
     * 按钮现在的坐标。它是这里唯一的位置真相 —— 拖动过程中每走一像素都只写这个 ref 和
     * DOM 的 style，一次 React 重渲染都不产生（见 skills/frontend-runtime-guardrails）。
     * 拖完才写回 store，也就是才让别的订阅者知道。
     */
    const positionRef = useRef<PonderTouchButtonPosition | null>(null);
    /** 用户有没有亲手放过它。没放过的话，视口变了就该回到默认的右上角。 */
    const isCustomPositionRef = useRef(storedPosition !== null);
    const dragRef = useRef<DragState | null>(null);

    /** 第一次用到位置时才结算：视口大小只有浏览器里才有。 */
    const resolvePosition = useCallback((): PonderTouchButtonPosition => {
        if (positionRef.current === null) {
            const viewport = readViewport();
            positionRef.current = storedPosition
                ? clampPonderTouchButtonPosition(storedPosition, viewport)
                : defaultPonderTouchButtonPosition(viewport);
        }
        return positionRef.current;
    }, [storedPosition]);

    const paint = useCallback(() => {
        const node = buttonRef.current;
        if (!node) return;
        const position = resolvePosition();
        // 和 React 的 style 相比这是绕过去的写法，所以下面那个 layout effect 每渲染一次都重刷，
        // 免得某次重渲染把拖动中的坐标打回去。
        node.style.left = `${position.x}px`;
        node.style.top = `${position.y}px`;
    }, [resolvePosition]);

    useLayoutEffect(() => {
        paint();
    });

    const reveal = useCallback(() => {
        setIsRevealed(true);
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            // 手指还按着的时候不许收：那会把按钮从手指下面抽走。
            if (dragRef.current) {
                return;
            }
            setIsRevealed(false);
        }, REVEAL_MS);
    }, []);

    // 换页时重新露一次：这颗按钮讲的是「思索当前页面」，页面换了就值得再说一遍自己在。
    useEffect(() => {
        if (!isCoarsePointer || !showTouchButton) {
            return undefined;
        }
        reveal();
        return () => {
            if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
        };
    }, [isCoarsePointer, reveal, showTouchButton, view]);

    // 横竖屏和视口变化：拖过的位置钳进新视口，没拖过的回到右上角。
    useEffect(() => {
        if (!isCoarsePointer || !showTouchButton || typeof window === 'undefined') {
            return undefined;
        }
        const handleResize = () => {
            const viewport = readViewport();
            positionRef.current = isCustomPositionRef.current && positionRef.current
                ? clampPonderTouchButtonPosition(positionRef.current, viewport)
                : defaultPonderTouchButtonPosition(viewport);
            paint();
        };
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('orientationchange', handleResize);
        };
    }, [isCoarsePointer, paint, showTouchButton]);

    const isInHotspot = useCallback((clientX: number, clientY: number): boolean => {
        const position = resolvePosition();
        // 按钮 48、热区 96，所以两侧各外扩 24：按下按钮旁边的空白也算按它。
        const pad = (HOTSPOT_SIZE_PX - PONDER_TOUCH_BUTTON_SIZE_PX) / 2;
        return clientX >= position.x - pad
            && clientX <= position.x + PONDER_TOUCH_BUTTON_SIZE_PX + pad
            && clientY >= position.y - pad
            && clientY <= position.y + PONDER_TOUCH_BUTTON_SIZE_PX + pad;
    }, [resolvePosition]);

    // 热区。按坐标判而不是摆一个元素：摆元素就会挡住底下的东西，
    // 而「不挡路」正是这颗按钮最要紧的一条。
    useEffect(() => {
        if (!isCoarsePointer || !showTouchButton || typeof window === 'undefined') {
            return undefined;
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') {
                return;
            }

            if (!isInHotspot(event.clientX, event.clientY)) {
                // 手指落在别处，上一面没用掉的旗就作废 —— 免得它留到下一次真正的点击上。
                suppressNextClickRef.current = false;
                return;
            }

            // 按钮已经露着的时候，这一下就是在按它，不该吃掉。
            suppressNextClickRef.current = !isRevealedRef.current;
            reveal();
        };

        window.addEventListener('pointerdown', handlePointerDown, { passive: true, capture: true });
        return () => window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    }, [isCoarsePointer, isInHotspot, reveal, showTouchButton]);

    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        const origin = resolvePosition();
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: origin.x,
            originY: origin.y,
            moved: false,
        };
        // 按住的时候停了收起计时器，松手时 reveal() 会重新计时。
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // 没有指针捕获也还能拖，只是手指滑出按钮那一下会断。
        }
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved) {
            if (Math.hypot(dx, dy) < PONDER_TOUCH_BUTTON_DRAG_THRESHOLD_PX) {
                return;
            }
            drag.moved = true;
            // transition-all 会把 left/top 也一起补间，拖起来像拖一条橡皮筋。
            event.currentTarget.style.transition = 'none';
        }
        const next = clampPonderTouchButtonPosition(
            { x: drag.originX + dx, y: drag.originY + dy },
            readViewport(),
        );
        positionRef.current = next;
        event.currentTarget.style.left = `${next.x}px`;
        event.currentTarget.style.top = `${next.y}px`;
    };

    const handleDragEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        dragRef.current = null;
        const node = event.currentTarget;
        node.style.transition = '';
        try {
            if (node.hasPointerCapture(event.pointerId)) {
                node.releasePointerCapture(event.pointerId);
            }
        } catch {
            // 捕获多半已经跟着指针一起没了。
        }
        if (drag.moved) {
            isCustomPositionRef.current = true;
            suppressNextClickRef.current = true;
            if (positionRef.current) {
                setStoredPosition(positionRef.current);
            }
        }
        reveal();
    };

    if (!isCoarsePointer || !showTouchButton || hasSession || isOnboardingOpen) {
        return null;
    }

    return (
        <button
            ref={buttonRef}
            type="button"
            data-testid="page-ponder-touch-button"
            data-ponder-touch-revealed={isRevealed || undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
            onClick={() => {
                if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    return;
                }
                openCurrentPagePonder();
            }}
            aria-label={t('ponder.openPage')}
            title={t('ponder.openPage')}
            // 收起来之后不可点：留着可点的话，它那块位置会变成一片看不见却能按的地方。
            // 坐标走 style（left/top），不走 right/top —— 拖动就是把 top/left 一路改过去。
            className={`fixed z-[190] flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all duration-200 active:scale-95 ${
                isRevealed ? 'opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'
            } ${isDaylight ? 'border-black/10 bg-white/80' : 'border-white/15 bg-zinc-900/80'}`}
            style={{ color: accent }}
        >
            <Lightbulb size={20} aria-hidden="true" />
        </button>
    );
};

export default PagePonderTouchButton;
