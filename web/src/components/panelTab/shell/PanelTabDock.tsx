// src/components/panelTab/shell/PanelTabDock.tsx
//
// 控制面板底边那一行页签，按上游 v0.7.22 的 TabDock 重做。
//
// 上游把这一行沉到了面板的底边：像一条 dock，而不是顶部那排图标按钮。空间够的时候每个页签
// 都带名字；加进来一个模组页签、换了种更长的语言、或者窗口太窄装不下名字时，没打开的那几格
// 只显示图标，打开的那格仍然图标 + 名字。够不够是**量**出来的：把名字按原样排一遍藏在视口外，
// 拿它的宽度和这一行比。
//
// 上游那份 TabDock 用的是设置套件里的 Segments / Tooltip（那是一整套 35 个组件的东西），
// 我们这边没有，所以视觉与测量逻辑照着实现，依赖换成面板自己的颜色变量和原生 title。
import React from 'react';
import { motion } from 'framer-motion';

export type DockTab<T extends string> = {
    id: T;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
};

type PanelTabDockProps<T extends string> = {
    tabs: ReadonlyArray<DockTab<T>>;
    currentTab: T;
    onTabChange: (tab: T) => void;
    isDaylight: boolean;
};

/** 名字排一遍、量出来，和这一行的宽度比：装得下就都带名字。 */
const useNamesFit = (deps: number) => {
    const rowRef = React.useRef<HTMLDivElement | null>(null);
    const namesRef = React.useRef<HTMLDivElement | null>(null);
    const [fits, setFits] = React.useState(false);

    React.useLayoutEffect(() => {
        const measure = () => {
            const row = rowRef.current;
            const names = namesRef.current;
            if (!row || !names) return;
            // 一像素的余量，抵浏览器取整。
            setFits(names.scrollWidth <= row.clientWidth + 1);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        if (rowRef.current) observer.observe(rowRef.current);
        if (namesRef.current) observer.observe(namesRef.current);
        return () => observer.disconnect();
    }, [deps]);

    return { rowRef, namesRef, fits };
};

export const PanelTabDock = <T extends string>({
    tabs,
    currentTab,
    onTabChange,
    isDaylight,
}: PanelTabDockProps<T>): React.ReactElement => {
    const { rowRef, namesRef, fits } = useNamesFit(tabs.length);

    const trackBg = isDaylight ? 'bg-black/5' : 'bg-white/5';
    const markBg = isDaylight ? 'bg-black/10' : 'bg-white/10';
    const activeText = isDaylight ? 'text-zinc-900' : 'text-white';
    const idleText = isDaylight ? 'text-zinc-500' : 'text-white/55';

    return (
        <div ref={rowRef} className={`shrink-0 px-3 pb-3 pt-2 border-t ${isDaylight ? 'border-black/5' : 'border-white/5'}`}>
            <div role="group" className={`flex w-full ${trackBg} p-0.5 h-9 rounded-[10px]`}>
                {tabs.map((tab) => {
                    const selected = tab.id === currentTab;
                    // 上游的取舍：名字都装得下时**只显示名字**（不画图标，否则图标宽度没人算进测量）；
                    // 装不下时没打开的只显示图标，打开的那格仍然图标 + 名字。
                    const nameOnly = fits;
                    const showName = fits || selected;
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => {
                                if (!selected) onTabChange(tab.id);
                            }}
                            aria-pressed={selected}
                            aria-label={showName ? undefined : tab.label}
                            title={tab.label}
                            // 每一格各自是一个思索目标：停在哪一格，讲的就是哪一页。
                            data-ponder-panel-tab-button={tab.id}
                            className={`relative flex h-full min-w-0 items-center justify-center whitespace-nowrap rounded-lg text-[13px] transition-colors
                                ${showName ? 'flex-[0_1_auto] px-2.5' : 'flex-[1_1_36px]'}
                                ${selected ? activeText : `${idleText} hover:text-current`}`}
                        >
                            {selected && (
                                // 同一块高亮跟着选择滑动：layoutId 让 framer-motion 在切换时把它移过去，
                                // 而不是每格各画一个。
                                <motion.span
                                    layoutId="panel-tab-dock-mark"
                                    layoutDependency={currentTab}
                                    transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.6 }}
                                    className={`absolute inset-0 ${markBg}`}
                                    style={{ borderRadius: 8, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.18)' }}
                                />
                            )}
                            <span className="relative flex min-w-0 items-center gap-1.5">
                                {!nameOnly && <Icon size={16} />}
                                {showName && <span className="truncate">{tab.label}</span>}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* 名字按这一行会用的字号排一遍，藏在视口外，只为量宽度。 */}
            <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
                <div ref={namesRef} className="inline-flex px-0.5 text-[13px]">
                    {tabs.map((tab) => (
                        <span key={tab.id} className="whitespace-nowrap px-2.5">{tab.label}</span>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default PanelTabDock;
