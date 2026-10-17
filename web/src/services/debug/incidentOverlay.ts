import type { Incident } from './incidents';

// src/services/debug/incidentOverlay.ts
// The only thing that can still appear after React is gone.
//
// If the root tree unmounts (an exception in render or in an effect, and nothing catches it), every
// component including an error boundary is off the page, and `body` is #09090b - the screen is black
// with the WebView perfectly alive. A React-rendered message cannot exist in that state, so this is
// plain DOM appended to the document, styled inline: no Tailwind class, no portal, no store.
//
// Deliberately NOT shown for ordinary errors. A thrown click handler leaves a working app, and
// covering the player with a red box for it would be worse than the exception. It is reserved for
// "there is nothing on the screen", which is the state it can also fix.

const OVERLAY_ID = 'folia-incident-overlay';

const formatTime = (at: number): string => {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const KIND_LABEL: Record<Incident['kind'], string> = {
    error: '未捕获异常',
    rejection: '未处理的 Promise 拒绝',
    'gl-lost': 'WebGL 上下文丢失',
    'gl-restored': 'WebGL 上下文恢复',
    'blank-root': 'React 根节点空了',
};

export type IncidentOverlayOptions = {
    title: string;
    incidents: readonly Incident[];
};

/** Shows (or replaces) the overlay. The reload button is the whole point of it existing. */
export const showIncidentOverlay = ({ title, incidents }: IncidentOverlayOptions): void => {
    if (typeof document === 'undefined') {
        return;
    }
    document.getElementById(OVERLAY_ID)?.remove();

    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.setAttribute('role', 'alertdialog');
    host.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483600',
        'display:flex', 'flex-direction:column', 'gap:12px',
        'padding:20px', 'box-sizing:border-box',
        'background:rgba(9,9,11,0.96)', 'color:#e4e4e7',
        'font:500 13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
        'overflow:auto',
    ].join(';');

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'font-weight:700;font-size:15px;color:#fca5a5;flex:none';
    host.appendChild(heading);

    const hint = document.createElement('div');
    hint.textContent = '这条信息会保留到下次重载之后；重新加载一般能回到可用状态。';
    hint.style.cssText = 'opacity:0.6;flex:none';
    host.appendChild(hint);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0';
    for (const incident of incidents.slice(-6)) {
        const line = document.createElement('div');
        line.style.cssText = 'padding:8px 10px;border-radius:8px;background:rgba(148,163,184,0.12);word-break:break-word';
        const meta = document.createElement('div');
        meta.textContent = `${formatTime(incident.at)} · ${KIND_LABEL[incident.kind]}`;
        meta.style.cssText = 'opacity:0.55;font-size:11px';
        const detail = document.createElement('div');
        detail.textContent = incident.detail || '(无内容)';
        line.append(meta, detail);
        list.appendChild(line);
    }
    host.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex:none';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = '重新加载';
    reload.style.cssText = [
        'flex:1 1 auto', 'padding:10px 14px', 'border-radius:10px', 'cursor:pointer',
        'border:1px solid rgba(147,197,253,0.5)', 'background:rgba(59,130,246,0.25)',
        'color:#dbeafe', 'font:inherit', 'font-weight:700',
    ].join(';');
    reload.addEventListener('click', () => window.location.reload());

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '关闭';
    dismiss.style.cssText = [
        'flex:0 0 auto', 'padding:10px 14px', 'border-radius:10px', 'cursor:pointer',
        'border:1px solid rgba(148,163,184,0.35)', 'background:transparent',
        'color:#cbd5e1', 'font:inherit',
    ].join(';');
    dismiss.addEventListener('click', () => host.remove());

    actions.append(reload, dismiss);
    host.appendChild(actions);
    document.body.appendChild(host);
};

export const hideIncidentOverlay = (): void => {
    if (typeof document === 'undefined') {
        return;
    }
    document.getElementById(OVERLAY_ID)?.remove();
};
