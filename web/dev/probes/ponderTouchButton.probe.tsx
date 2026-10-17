import React from 'react';
import '../../src/i18n/config';
import PagePonderTouchButton from '../../src/components/ponder/PagePonderTouchButton';
import { usePonderStore } from '../../src/stores/usePonderStore';
import type { ProbeDefinition } from './definition';
// dev/probes/ponderTouchButton.probe.tsx

/**
 * 触屏上那颗思索浮动按钮的拖动。
 *
 * 这条链路单测盖不住：位置是直接写到 DOM 的 style 上的（每走一像素都不许经过 React），
 * 拖动与「按下」靠 6px 的位移阈值分开，松开那一下的 click 还要被吃掉。这些只有真实的
 * pointer 事件序列能验证。
 *
 * 前提：本探针只在粗指针下渲染出按钮（`useSupportsFinePointer`）。所以 spec 里必须带
 * `test.use({ hasTouch: true })`，否则组件返回 null，测的是一片空白。
 *
 * 读回的东西：
 * - `data-probe-position`：store 里记住的位置（松手才写），格式 `x,y`，没拖过是空
 * - `data-probe-session`：有没有打开思索（拖动之后不该打开）
 * spec 另外直接读按钮自己的 inline `left` / `top`，那是拖动过程中唯一的真相。
 */
const ProbeBody: React.FC = () => {
    const position = usePonderStore(state => state.ponderTouchButtonPosition);
    const hasSession = usePonderStore(state => state.session !== null);

    return (
        <div className="relative min-h-screen bg-zinc-950">
            <div
                data-probe-state
                data-probe-position={position ? `${position.x},${position.y}` : ''}
                data-probe-session={hasSession ? 'open' : 'closed'}
                className="pointer-events-none fixed bottom-2 left-2 z-[300] text-xs text-zinc-400"
            >
                position: {position ? `${position.x},${position.y}` : '—'} · session:{' '}
                {hasSession ? 'open' : 'closed'}
            </div>

            <PagePonderTouchButton accent="#f43f5e" isDaylight={false} />
        </div>
    );
};

const probe: ProbeDefinition = {
    id: 'ponderTouchButton',
    title: '思索·触屏按钮拖动',
    description: '按住拖动能改位置、松手写进 store、拖出屏幕会被钳回、松手那一下不打开思索',
    Component: ProbeBody,
};

export default probe;
