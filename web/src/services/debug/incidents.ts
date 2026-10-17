// src/services/debug/incidents.ts
// What went wrong, kept somewhere a phone with no adb can still show it.
//
// A black screen is the worst possible bug report: `body` is #09090b, so an unmounted React tree
// and a healthy app whose background layers stopped drawing look identical, and this device has no
// console to ask (see frameSamples.ts for the same argument). Every path that can blank the screen
// therefore records a line here, and the frame HUD prints the last one: "it went black again"
// becomes a screenshot with a message in it.
//
// The ring lives in memory AND its tail is persisted, because the interesting case is the one where
// the page had to be reloaded: the evidence has to outlive the document that produced it.

export type IncidentKind = 'error' | 'rejection' | 'gl-lost' | 'gl-restored' | 'blank-root';

export type Incident = {
    /** Date.now() when it happened. */
    at: number;
    kind: IncidentKind;
    detail: string;
};

/** Enough to see a pattern in one session; small enough that a stuck loop cannot grow it. */
const CAPACITY = 64;

/** Only the tail is persisted: localStorage holds one string and is written synchronously. */
const PERSISTED = 8;

const STORAGE_KEY = 'folia_incidents';

/** Longest detail kept. An exception message with a stack can be thousands of characters. */
const DETAIL_MAX = 220;

const isIncidentKind = (value: unknown): value is IncidentKind =>
    value === 'error' || value === 'rejection' || value === 'gl-lost'
    || value === 'gl-restored' || value === 'blank-root';

/** Collapses whitespace and clips: an exception message is often several lines of noise. */
export const clipDetail = (detail: string): string => {
    const flat = detail.replace(/\s+/g, ' ').trim();
    return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
};

/** Tolerant on purpose: a corrupt entry must cost that entry, never the whole log. */
const readPersisted = (): Incident[] => {
    if (typeof localStorage === 'undefined') {
        return [];
    }
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap(entry => {
            if (!entry || typeof entry !== 'object') {
                return [];
            }
            const { at, kind, detail } = entry as Record<string, unknown>;
            if (typeof at !== 'number' || !Number.isFinite(at) || !isIncidentKind(kind)) {
                return [];
            }
            return [{ at, kind, detail: typeof detail === 'string' ? clipDetail(detail) : '' }];
        }).slice(-PERSISTED);
    } catch {
        // Private mode, quota, or a JSON parser error: an empty log beats a module that throws on
        // import, which would take the whole app down at boot.
        return [];
    }
};

const listeners = new Set<() => void>();

/** Newest last, so the HUD and any overlay can read the tail without sorting. */
let incidents: Incident[] = readPersisted();

/** Serialisable snapshot for useSyncExternalStore consumers. */
let snapshot: readonly Incident[] = incidents.slice();

const persist = () => {
    if (typeof localStorage === 'undefined') {
        return;
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(incidents.slice(-PERSISTED)));
    } catch {
        // Same reasoning as above, in the other direction: losing the log must not break the app.
    }
};

const publish = () => {
    snapshot = incidents.slice();
    listeners.forEach(listener => listener());
};

/** The one way anything gets written. Never throws. */
export const recordIncident = (kind: IncidentKind, detail: string): Incident => {
    const incident: Incident = { at: Date.now(), kind, detail: clipDetail(detail) };
    incidents.push(incident);
    if (incidents.length > CAPACITY) {
        incidents = incidents.slice(-CAPACITY);
    }
    persist();
    publish();
    return incident;
};

export const readIncidents = (): readonly Incident[] => snapshot;

/** The most recent entry of one kind, or of any kind when `kind` is omitted. */
export const lastIncident = (kind?: IncidentKind): Incident | null => {
    for (let index = incidents.length - 1; index >= 0; index -= 1) {
        const incident = incidents[index];
        if (!kind || incident.kind === kind) {
            return incident;
        }
    }
    return null;
};

export const countIncidents = (kind: IncidentKind): number =>
    incidents.reduce((total, incident) => (incident.kind === kind ? total + 1 : total), 0);

/** Both counts together: what the HUD's `gl` row shows. */
export const countContextLosses = () => ({
    lost: countIncidents('gl-lost'),
    restored: countIncidents('gl-restored'),
});

export const subscribeToIncidents = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const clearIncidents = (): void => {
    incidents = [];
    persist();
    publish();
};

/** Test seam: the limits are asserted rather than duplicated in the test. */
export const INCIDENT_LIMITS = { CAPACITY, PERSISTED, STORAGE_KEY, DETAIL_MAX } as const;
