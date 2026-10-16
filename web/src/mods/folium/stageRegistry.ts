import { playerOverlayLayout } from '@/services/playerOverlayLayout';
import { isMainAppSurface } from '@/utils/appSurface';
import type { ModRuntimeInfo } from '../types';
import type { FoliumContextKind, FoliumMount, FoliumRegistry, FoliumStageContext } from './contract';
import type { FoliumHostRegistry, FoliumRegistryEntry } from './registry';

// src/mods/folium/stageRegistry.ts
// Bind stage mounts to their registration and manifest. Each actual mount owns
// its subscriptions, so stale contexts cannot reactivate geometry observation.

type StageDefinition = { id: string; mount: FoliumMount<FoliumStageContext> };

/** A fresh scope per mount, including React's effect replay in StrictMode. */
const mountStage = (
    mount: FoliumMount<FoliumStageContext>,
    container: HTMLElement,
    base: FoliumStageContext,
    layoutAllowed: boolean,
    isCurrent: () => boolean,
    subscribeOwner: (listener: () => void) => () => void,
) => {
    let active = true;
    const listeners = new Map<symbol, () => void>();
    let stopBase: (() => void) | undefined;
    let stopLayout: (() => void) | undefined;
    let stopOwner: (() => void) | undefined;
    const allowed = layoutAllowed && !base.isPreview && isMainAppSurface;
    const current = () => active && isCurrent();
    const stopListening = () => {
        stopBase?.(); stopBase = undefined;
        stopLayout?.(); stopLayout = undefined;
    };
    const disposeScope = () => {
        active = false;
        stopListening();
        stopOwner?.(); stopOwner = undefined;
        listeners.clear();
    };
    const notify = () => {
        if (!current()) { disposeScope(); return; }
        for (const [token, listener] of [...listeners]) {
            if (!current()) break;
            if (!listeners.has(token)) continue;
            try { listener(); } catch (error) { console.warn('[Folium] stage subscriber failed', error); }
        }
    };
    const ctx: FoliumStageContext = Object.freeze({
        ...base,
        getLayout: () => current() && allowed ? playerOverlayLayout.source.get() : null,
        subscribe: (listener: () => void) => {
            if (!current()) return () => {};
            const token = Symbol();
            listeners.set(token, listener);
            if (listeners.size === 1) {
                stopBase = base.subscribe(notify);
                if (allowed) stopLayout = playerOverlayLayout.source.subscribe(notify);
            }
            return () => {
                listeners.delete(token);
                if (!listeners.size) stopListening();
            };
        },
    });
    stopOwner = subscribeOwner(() => { if (!isCurrent()) disposeScope(); });
    try {
        const disposeMount = mount(container, ctx);
        return () => {
            disposeScope();
            disposeMount?.();
        };
    } catch (error) {
        disposeScope();
        throw error;
    }
};

/** Only stage-shaped registries need manifest/layout ownership; the shared registry stays generic. */
export const bindFoliumStageRegistry = <Def extends StageDefinition, Stored>(
    registry: FoliumHostRegistry<Def, Stored>,
    mod: Pick<ModRuntimeInfo, 'id' | 'experimental'>,
    context: FoliumContextKind,
): FoliumRegistry<Def> => {
    const layoutAllowed = context === 'main' && (mod.experimental ?? []).includes('player.layout');
    return Object.freeze({
        register: (def: Def) => {
            // Leave invalid definitions to the registry's existing validation.
            if (typeof def?.mount !== 'function') return registry.register(mod.id, def);
            const render = def.mount;
            let entry: FoliumRegistryEntry<Stored> | null = null;
            const isCurrent = () => entry !== null && registry.get(entry.id) === entry;
            const mount: FoliumMount<FoliumStageContext> = (container, base) => {
                if (!isCurrent()) return;
                return mountStage(render, container, base, layoutAllowed, isCurrent, registry.subscribe);
            };
            const handle = registry.register(mod.id, { ...def, mount });
            entry = registry.get(handle.id);
            return handle;
        },
    });
};
