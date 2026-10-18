import React from 'react';
import { recordIncident } from '../services/debug/incidents';
import { isDynamicImportFailure } from '../utils/chunkLoadFailure';

// src/components/AppErrorBoundary.tsx
// 根组件树的最后一道网。
//
// 为什么需要它：这个应用之前**一个错误边界都没有**，于是任何一个 render / effect 里的异常都会让
// React 把整棵树卸载 —— 屏幕上只剩 `body` 的 #09090b。实机上抓到的那次就是这么黑的：
// `TypeError: Failed to fetch dynamically imported module: …/BravaisCollection-Cys-1Rmu.js`。
//
// 分两条路处理，因为这两种失败的正确应对不一样：
//
// 1. **懒加载 chunk 拿不到**：chunk 名是内容哈希，APK 一更新旧名字就没了（典型原因是旧的
//    service worker 还在用缓存里的旧 index.html 指向旧 chunk）。正确的处理是重载一次去拿新的，
//    所以这里自动重载，并用 sessionStorage 保证一次会话只重载一次——重载成环比黑屏更糟。
// 2. **其它异常**：渲染一张能读的说明 + 重载按钮，先让人能出来，再去修。
//
// 两条路都会写进事故日志（services/debug/incidents.ts），黑屏之后还能读到发生了什么。

/** 一次会话里自动重载的时间窗；窗口内第二次同类失败就不再重载，交给兜底界面。 */
const AUTO_RELOAD_WINDOW_MS = 60_000;
const AUTO_RELOAD_KEY = 'folia_chunk_reload_at';

type AppErrorBoundaryProps = {
    children: React.ReactNode;
    /** 显示在兜底界面上的名字，用来区分主界面 / 远程控制 / OBS 源。 */
    surface?: string;
};

type AppErrorBoundaryState = {
    error: Error | null;
};

class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error) {
        recordIncident('error', `${error.name}: ${error.message}`);
        if (!isDynamicImportFailure(error.message)) {
            return;
        }
        try {
            const last = Number(window.sessionStorage.getItem(AUTO_RELOAD_KEY) ?? 0);
            if (Number.isFinite(last) && Date.now() - last < AUTO_RELOAD_WINDOW_MS) {
                return;
            }
            window.sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
        } catch {
            // 隐私模式拿不到 sessionStorage：宁可让用户手动点，也不要冒重载成环的风险。
            return;
        }
        window.location.reload();
    }

    private handleReload = () => {
        window.location.reload();
    };

    render() {
        const { error } = this.state;
        if (!error) {
            return this.props.children;
        }

        const surface = this.props.surface ? `（${this.props.surface}）` : '';
        const chunk = isDynamicImportFailure(error.message);

        return (
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 2147483600,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    padding: 20,
                    boxSizing: 'border-box',
                    background: 'rgba(9,9,11,0.97)',
                    color: '#e4e4e7',
                    font: '500 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
            >
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fca5a5' }}>
                    界面渲染出错{surface}
                </div>
                <div style={{ opacity: 0.62 }}>
                    {chunk
                        ? '有一块页面代码没加载上（通常是应用刚更新过）。重新加载一般就好。'
                        : '这一处出错之后 React 会卸载整棵树，所以先把界面停在这里，而不是留下一片黑屏。'}
                </div>
                <div
                    style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'rgba(148,163,184,0.12)',
                        wordBreak: 'break-word',
                    }}
                >
                    {error.name}: {error.message}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <button
                        type="button"
                        onClick={this.handleReload}
                        style={{
                            flex: '1 1 auto',
                            padding: '10px 14px',
                            borderRadius: 10,
                            border: '1px solid rgba(147,197,253,0.5)',
                            background: 'rgba(59,130,246,0.25)',
                            color: '#dbeafe',
                            font: 'inherit',
                            fontWeight: 700,
                            cursor: 'pointer',
                        }}
                    >
                        重新加载
                    </button>
                </div>
            </div>
        );
    }
}

export default AppErrorBoundary;
