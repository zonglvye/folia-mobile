import { readIncidents, recordIncident } from './incidents';
import { showIncidentOverlay } from './incidentOverlay';

// src/services/debug/installIncidentRecorders.ts
// Installs the listeners that turn a black screen into a line of text.
//
// Called once from bootstrap, before the first render, so an exception thrown during the first
// commit is already covered. Everything here is passive: no polling of layout, no per-frame work,
// and the only periodic timer is the blank-root watchdog, which reads one property twice a second.

/** A canvas is worth naming precisely: on this app a context loss is either a background layer or a lyric surface. */
export const describeIncidentTarget = (target: EventTarget | null): string => {
    if (!(target instanceof HTMLCanvasElement)) {
        return target instanceof Element ? `${target.tagName.toLowerCase()}` : 'unknown';
    }
    const parent = target.parentElement;
    const parentLabel = parent
        ? `${parent.tagName.toLowerCase()}${parent.className ? `.${String(parent.className).split(/\s+/).slice(0, 2).join('.')}` : ''}`
        : 'no-parent';
    return `canvas ${target.width}x${target.height} in ${parentLabel}`;
};

const describeRejection = (reason: unknown): string => {
    if (reason instanceof Error) {
        return `${reason.name}: ${reason.message}`;
    }
    if (typeof reason === 'string') {
        return reason;
    }
    try {
        return JSON.stringify(reason) ?? String(reason);
    } catch {
        return String(reason);
    }
};

/**
 * Every way the page can fail silently: uncaught exceptions, unhandled rejections, and WebGL
 * context loss.
 *
 * Context loss is recorded from the document in the capture phase because the event does not
 * bubble, and the canvases that lose contexts are created by third-party shader plumbing that has
 * no reason to listen. `preventDefault` is deliberately NOT called here: it promises the browser a
 * restore, and these layers cannot rebuild their pipelines, so allowing a restore would only
 * replace "nothing drawn" with "restored context drawing nothing". Recording it is the point.
 */
export const installIncidentRecorders = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    window.addEventListener('error', event => {
        const errorEvent = event as ErrorEvent;
        // Resource load failures also land here (they reach window in the capture phase). They are
        // worth a line, but the message has to say which URL failed, not just "Script error".
        if (errorEvent.error instanceof Error) {
            recordIncident('error', `${errorEvent.error.name}: ${errorEvent.error.message}`);
            return;
        }
        const target = event.target;
        if (target instanceof HTMLScriptElement) {
            recordIncident('error', `script failed to load: ${target.src}`);
            return;
        }
        if (target instanceof HTMLLinkElement) {
            recordIncident('error', `stylesheet failed to load: ${target.href}`);
            return;
        }
        if (errorEvent.message) {
            recordIncident('error', `${errorEvent.message} @ ${errorEvent.filename ?? '?'}:${errorEvent.lineno ?? 0}`);
        }
    }, true);

    window.addEventListener('unhandledrejection', event => {
        recordIncident('rejection', describeRejection((event as PromiseRejectionEvent).reason));
    });

    document.addEventListener('webglcontextlost', event => {
        recordIncident('gl-lost', describeIncidentTarget(event.target));
    }, true);

    document.addEventListener('webglcontextrestored', event => {
        recordIncident('gl-restored', describeIncidentTarget(event.target));
    }, true);
};

/** How often the root is checked. One property read twice a second is below anything measurable. */
const BLANK_ROOT_POLL_MS = 1200;

/**
 * Starts the black-screen detector: if the React root ends up with no children after it has once
 * had some, nothing can be rendered by the app any more, so the plain-DOM overlay is the only thing
 * left that can speak.
 *
 * Two guards keep it honest: it does not arm until the root has actually held children (a check
 * during the first paint would fire on every boot), and it fires once per document rather than
 * once per poll.
 */
export const armBlankRootWatchdog = (root: HTMLElement): (() => void) => {
    if (typeof window === 'undefined') {
        return () => {};
    }

    let armed = false;
    let reported = false;

    const timer = window.setInterval(() => {
        const populated = root.childElementCount > 0;
        if (populated) {
            armed = true;
            return;
        }
        if (!armed || reported) {
            return;
        }
        reported = true;
        recordIncident('blank-root', 'React root has no children; the tree was unmounted');
        showIncidentOverlay({
            title: '界面已停止渲染（黑屏）',
            incidents: readIncidents(),
        });
    }, BLANK_ROOT_POLL_MS);

    return () => window.clearInterval(timer);
};
