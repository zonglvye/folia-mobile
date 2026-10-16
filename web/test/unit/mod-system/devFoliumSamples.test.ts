// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
    FoliumClientApi,
    FoliumCommandDef,
    FoliumEventMap,
    FoliumHomeTabDef,
    FoliumLoopMode,
    FoliumPanelContext,
    FoliumPlaybackService,
    FoliumQueueSnapshot,
    FoliumSong,
} from '@/mods/folium/contract';

// test/unit/mod-system/devFoliumSamples.test.ts
// The demonstration mods under dev/folium/ (every directory there holding a mod.json) are Folium 1
// mods like the signed samples in mods/: the manifest validates, the declared entries exist, and the
// client uses the literal `export default function activate(folium)` form authors copy. Unlike
// mods/ they are unsigned (installed by hand, never scanned by the loader), so no signature check.
// sample-playback-console also runs here: its main entry against the real api.storage.paths
// (append, cache, rebuild after the cache is emptied) and its client against a stand-in folium.

const require = createRequire(import.meta.url);
const { validateManifest } = require('../../../electron/modSystem/manifest.cjs');
const { createModApi, createModDataStore } = require('../../../electron/modSystem/modApi.cjs');
const { clearDirectoryContents, resolveModStorageDirs } = require('../../../electron/modSystem/modFiles.cjs');

const DEV_FOLIUM_DIR = path.resolve(__dirname, '../../../dev/folium');
const PLAYBACK_CONSOLE_DIR = path.join(DEV_FOLIUM_DIR, 'sample-playback-console');
const sampleDirectories = fs.readdirSync(DEV_FOLIUM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(DEV_FOLIUM_DIR, entry.name, 'mod.json')))
    .map((entry) => path.join(DEV_FOLIUM_DIR, entry.name));
const samples = sampleDirectories.map((directory) => [path.basename(directory), directory]);

const temporaryDirectories: string[] = [];
afterEach(() => {
    while (temporaryDirectories.length > 0) {
        fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
    document.body.replaceChildren();
});

describe('dev/folium sample mods', () => {
    it('has the samples the docs point to', () => {
        expect(samples.map(([name]) => name)).toEqual(expect.arrayContaining(['sample-home-tab', 'sample-playback-console']));
    });

    it.each(samples)('%s is a valid Folium 1 mod', (_name, directory) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'mod.json'), 'utf8'));
        const result = validateManifest(manifest);
        expect(result.ok ? [] : result.errors).toEqual([]);
        if (!result.ok) return;
        if (result.value.main) expect(fs.existsSync(path.join(directory, result.value.main))).toBe(true);
        if (result.value.client) {
            const clientPath = path.join(directory, result.value.client);
            expect(fs.existsSync(clientPath)).toBe(true);
            expect(fs.readFileSync(clientPath, 'utf8')).toMatch(/export default function activate\(folium\)/);
        }
    });

    it.each(samples)('%s ships unsigned, as the docs say', (_name, directory) => {
        expect(fs.existsSync(path.join(directory, 'folium.sig.json'))).toBe(false);
    });
});

/* The main entry, activated against the real mod api with its own userData under the temp directory. */
const activatePlaybackConsoleMain = () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-dev-sample-'));
    temporaryDirectories.push(userData);
    const manifest = JSON.parse(fs.readFileSync(path.join(PLAYBACK_CONSOLE_DIR, 'mod.json'), 'utf8'));
    const dirs = resolveModStorageDirs(userData, manifest.id);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const api = createModApi({
        modId: manifest.id,
        manifest,
        dataStore: createModDataStore(dirs.dataDir),
        filesDir: dirs.filesDir,
        cacheDir: dirs.cacheDir,
        hostInfo: { folium: { major: 1, minor: 5 }, folia: '0.7.20' },
        emitLog: () => {},
        getPlaybackSnapshot: () => null,
        registerDisposer: () => {},
        registerRpc: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler),
        requestExport: () => Promise.reject(new Error('unused')),
    });
    const activate = require(path.join(PLAYBACK_CONSOLE_DIR, 'index.cjs'));
    activate(api);
    const call = (name: string, ...args: unknown[]) => handlers.get(name)!(...args);
    return { dirs, call, handlers };
};

const failureRecord = (id: string, title: string) => ({
    id,
    at: 1_760_000_000_000,
    song: { title, artist: 'Artist', source: 'netease' },
    reason: 'restricted',
    phase: 'play',
    willAutoSkip: true,
});

describe('sample-playback-console main entry', () => {
    it('appends failures to the data log and lists them newest first from the cache', async () => {
        const { dirs, call, handlers } = activatePlaybackConsoleMain();
        expect([...handlers.keys()].sort()).toEqual(['recentFailures', 'recordFailure']);

        await call('recordFailure', failureRecord('a', 'First'));
        await call('recordFailure', failureRecord('b', 'Second'));

        const log = fs.readFileSync(path.join(dirs.filesDir, 'failures.log'), 'utf8').trim().split('\n');
        expect(log.map((line) => JSON.parse(line).id)).toEqual(['a', 'b']);
        expect(fs.existsSync(path.join(dirs.cacheDir, 'recent-failures.json'))).toBe(true);
        expect((await call('recentFailures') as Array<{ id: string }>).map((item) => item.id)).toEqual(['b', 'a']);
    });

    it('rebuilds the cache from the log after the mods panel empties it', async () => {
        const { dirs, call } = activatePlaybackConsoleMain();
        await call('recordFailure', failureRecord('a', 'First'));
        await call('recordFailure', failureRecord('b', 'Second'));

        await clearDirectoryContents(dirs.cacheDir);
        expect(fs.readdirSync(dirs.cacheDir)).toEqual([]);

        expect((await call('recentFailures') as Array<{ id: string }>).map((item) => item.id)).toEqual(['b', 'a']);
        expect(fs.existsSync(path.join(dirs.cacheDir, 'recent-failures.json'))).toBe(true);
        // A record after the rebuild is not listed twice.
        await clearDirectoryContents(dirs.cacheDir);
        await call('recordFailure', failureRecord('c', 'Third'));
        expect((await call('recentFailures') as Array<{ id: string }>).map((item) => item.id)).toEqual(['c', 'b', 'a']);
    });

    it('keeps only the fields it knows from what the renderer sends', async () => {
        const { call } = activatePlaybackConsoleMain();
        await call('recordFailure', { id: 'x', reason: 'bogus', phase: 'later', song: { title: 5, artist: 'A', ref: 'r' }, extra: 'drop me' });
        expect(await call('recentFailures')).toEqual([expect.objectContaining({
            id: 'x',
            reason: 'unknown',
            phase: 'play',
            willAutoSkip: false,
            song: { title: '', artist: 'A', source: null },
        })]);
    });
});

/*
 * A stand-in for the parts of folium the client uses. The playback half follows the contract's
 * types, and getQueue pages the way the host does (centred on the current song without an offset).
 */
const createFakeFolium = (context: 'main' | 'export' = 'main') => {
    const handlers = new Map<string, Array<{ handler: (event: unknown) => void; rank: number }>>();
    const homeTabs: FoliumHomeTabDef[] = [];
    const commands: FoliumCommandDef[] = [];
    const rpcCalls: Array<{ name: string; args: unknown[] }> = [];
    const queue: FoliumSong[] = Array.from({ length: 120 }, (_, index) => ({
        id: String(index), title: `Song ${index}`, artist: 'Artist', album: null, source: 'local', ref: `ref-${index}`,
    }));
    const state = { volume: 0.5, muted: false, loopMode: 'off' as FoliumLoopMode, currentIndex: 70 };
    const RANK: Record<string, number> = { highest: 0, high: 1, normal: 2, low: 3, lowest: 4 };

    const emit = <K extends keyof FoliumEventMap>(type: K, payload: FoliumEventMap[K]) => {
        (handlers.get(type) ?? []).forEach(({ handler }) => handler(Object.freeze({ ...payload })));
    };
    const playback: Pick<FoliumPlaybackService, 'getVolume' | 'setVolume' | 'setMuted' | 'getLoopMode' | 'setLoopMode' | 'getQueue' | 'playQueueItem'> = {
        getVolume: () => ({ volume: state.volume, muted: state.muted }),
        setVolume: vi.fn((volume: number) => {
            state.volume = volume;
            emit('playback.volumeChanged', { volume: state.volume, muted: state.muted });
        }),
        setMuted: vi.fn((muted: boolean) => {
            state.muted = muted;
            emit('playback.volumeChanged', { volume: state.volume, muted: state.muted });
        }),
        getLoopMode: () => state.loopMode,
        setLoopMode: vi.fn((mode: FoliumLoopMode) => {
            state.loopMode = mode;
            emit('playback.loopModeChanged', { mode });
        }),
        getQueue: (options = {}): FoliumQueueSnapshot => {
            const limit = options.limit ?? 500;
            const start = options.offset === undefined
                ? Math.min(Math.max(0, state.currentIndex - Math.floor(limit / 2)), Math.max(0, queue.length - limit))
                : Math.min(Math.max(0, options.offset), queue.length);
            return {
                items: queue.slice(start, start + limit).map((song, position) => ({ song, index: start + position })),
                length: queue.length,
                currentIndex: state.currentIndex,
                kind: 'queue',
            };
        },
        playQueueItem: vi.fn(async (index: number, expectedRef?: string) => queue[index]?.ref === expectedRef),
    };
    const folium = {
        modId: 'sample-playback-console',
        host: { folium: { major: 1, minor: 5 }, folia: '0.7.20' },
        env: { context },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        registries: {
            homeTabs: { register: (def: FoliumHomeTabDef) => { homeTabs.push(def); return { id: `sample-playback-console:${def.id}`, unregister: () => {} }; } },
            commands: { register: (def: FoliumCommandDef) => { commands.push(def); return { id: `sample-playback-console:${def.id}`, unregister: () => {} }; } },
        },
        events: {
            on: (type: string, handler: (event: unknown) => void, options?: { priority?: string }) => {
                const registration = { handler, rank: RANK[options?.priority ?? 'normal'] };
                handlers.set(type, [...(handlers.get(type) ?? []), registration].sort((left, right) => left.rank - right.rank));
                return () => handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== registration));
            },
        },
        playback,
        ui: { openHomeTab: vi.fn() },
        rpc: {
            call: async (name: string, ...args: unknown[]) => {
                rpcCalls.push({ name, args });
                return name === 'recentFailures' ? [{ ...failureRecord('old', 'Earlier'), at: 1 }] : { logged: true };
            },
        },
    } as unknown as FoliumClientApi;
    return { folium, homeTabs, commands, rpcCalls, emit, playback, state, handlerCount: () => [...handlers.values()].reduce((sum, list) => sum + list.length, 0) };
};

const panelContext = (locale: string): FoliumPanelContext => ({
    locale,
    getTheme: () => { throw new Error('unused'); },
    subscribe: () => () => {},
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sample-playback-console client', () => {
    const loadClient = async () => (await import('../../../dev/folium/sample-playback-console/client.mjs')).default as (folium: FoliumClientApi) => (() => void) | undefined;

    it('registers nothing in the export window', async () => {
        const activate = await loadClient();
        const fake = createFakeFolium('export');
        expect(activate(fake.folium)).toBeUndefined();
        expect(fake.homeTabs).toEqual([]);
        expect(fake.rpcCalls).toEqual([]);
    });

    it('registers the home page and a command that opens it', async () => {
        const activate = await loadClient();
        const fake = createFakeFolium();
        activate(fake.folium);
        expect(fake.homeTabs.map((def) => def.id)).toEqual(['console']);
        await fake.commands[0].run({ values: {} } as never);
        expect(fake.folium.ui.openHomeTab).toHaveBeenCalledWith('console');
    });

    it('shows and drives volume, repeat and the queue, and records failures through rpc', async () => {
        const activate = await loadClient();
        const fake = createFakeFolium();
        const deactivate = activate(fake.folium);
        await flush();
        const container = document.createElement('div');
        document.body.append(container);
        const dispose = fake.homeTabs[0].mount(container, panelContext('en'));

        const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
        expect(slider.value).toBe('50');
        slider.value = '30';
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));
        expect(fake.playback.setVolume).toHaveBeenCalledWith(0.3);
        fake.emit('playback.volumeChanged', { volume: 0.8, muted: true });
        expect(slider.value).toBe('80');

        const buttonNamed = (name: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === name)!;
        expect(buttonNamed('Off').getAttribute('aria-pressed')).toBe('true');
        buttonNamed('One song').click();
        expect(fake.playback.setLoopMode).toHaveBeenCalledWith('one');
        expect(buttonNamed('One song').getAttribute('aria-pressed')).toBe('true');

        // Centred on the current song: entries 45–94 of 120, with #70 marked current.
        const tracks = () => [...container.querySelectorAll<HTMLButtonElement>('button.track')];
        expect(tracks()).toHaveLength(50);
        expect(tracks()[0].textContent).toContain('Song 45');
        expect(container.querySelector('[aria-current="true"]')?.textContent).toContain('Song 70');
        tracks()[3].click();
        await flush();
        expect(fake.playback.playQueueItem).toHaveBeenCalledWith(48, 'ref-48');
        buttonNamed('Next page').click();
        expect(tracks()[0].textContent).toContain('Song 95');
        expect(buttonNamed('Next page').disabled).toBe(true);
        fake.state.currentIndex = 10;
        buttonNamed('Back to current').click();
        expect(tracks()[0].textContent).toContain('Song 0');
        // A redraw keeps keyboard focus on the same entry.
        tracks()[5].focus();
        fake.emit('playback.queueChanged', { length: 120, currentIndex: 10 });
        expect((document.activeElement as HTMLElement).dataset.index).toBe('5');

        fake.emit('playback.failed', {
            song: { id: '7', title: 'Locked', artist: 'Someone', album: null, source: 'netease', ref: 'ref-x' },
            reason: 'restricted',
            phase: 'play',
            willAutoSkip: true,
        });
        const record = fake.rpcCalls.find((entry) => entry.name === 'recordFailure')!.args[0];
        expect(JSON.parse(JSON.stringify(record))).toEqual(record);
        expect(record).toMatchObject({ song: { title: 'Locked', artist: 'Someone', source: 'netease' }, reason: 'restricted', phase: 'play', willAutoSkip: true });
        expect(container.textContent).toContain('Locked — Someone');
        // The record loaded from the main entry is listed after this session's.
        expect(container.textContent!.indexOf('Locked')).toBeLessThan(container.textContent!.indexOf('Earlier'));

        const listening = fake.handlerCount();
        (dispose as () => void)();
        expect(fake.handlerCount()).toBe(listening - 4);
        expect(container.childElementCount).toBe(0);
        deactivate?.();
        expect(fake.handlerCount()).toBe(0);
    });
});
