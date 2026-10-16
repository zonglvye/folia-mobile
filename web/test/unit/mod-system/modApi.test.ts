import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// test/unit/mod-system/modApi.test.ts
// The permission gate is the whole point of the `permissions` manifest field:
// a capability a mod did not declare has to be unreachable, not merely
// undocumented. These cover both directions for every guarded API family, the
// shared data store (queueing, quota), rpc registration and the deactivate
// hook the loader relies on to stop a disabled mod. Folium 1.5's
// `api.storage.paths` is covered here too: gated, frozen, and re-created on read.

const require = createRequire(import.meta.url);
const { createModApi, createModDataStore } = require('../../../electron/modSystem/modApi.cjs');

const temporaryDirectories: string[] = [];

const tempDir = () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-mod-api-'));
    temporaryDirectories.push(dataDir);
    return dataDir;
};

const createApi = (permissions: string[], overrides: Record<string, unknown> = {}) => createModApi({
    modId: 'test-mod',
    manifest: { id: 'test-mod', permissions },
    dataStore: createModDataStore(tempDir()),
    hostInfo: { folium: { major: 1, minor: 0 }, folia: '0.7.8' },
    emitLog: () => {},
    getPlaybackSnapshot: () => ({ song: null }),
    registerDisposer: () => {},
    registerRpc: () => {},
    requestExport: () => Promise.resolve({ ok: true }),
    ...overrides,
});

afterEach(() => {
    while (temporaryDirectories.length > 0) {
        fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    }
});

describe('mod api permission gate', () => {
    it('refuses the playback snapshot without runtime.playback', () => {
        expect(() => createApi([]).runtime.getPlaybackSnapshot()).toThrow('permission-denied:runtime.playback');
    });

    it('returns the playback snapshot once runtime.playback is declared', () => {
        expect(createApi(['runtime.playback']).runtime.getPlaybackSnapshot()).toEqual({ song: null });
    });

    it('rejects every storage operation without filesystem.data', async () => {
        const api = createApi([]);
        await expect(api.storage.data.get('k')).rejects.toThrow('permission-denied:filesystem.data');
        await expect(api.storage.data.set('k', 1)).rejects.toThrow('permission-denied:filesystem.data');
        await expect(api.storage.data.has('k')).rejects.toThrow('permission-denied:filesystem.data');
        await expect(api.storage.data.delete('k')).rejects.toThrow('permission-denied:filesystem.data');
        await expect(api.storage.data.keys()).rejects.toThrow('permission-denied:filesystem.data');
    });

    it('round-trips storage once filesystem.data is declared', async () => {
        const api = createApi(['filesystem.data']);
        await api.storage.data.set('answer', 42);
        expect(await api.storage.data.get('answer')).toBe(42);
        expect(await api.storage.data.has('answer')).toBe(true);
        expect(await api.storage.data.keys()).toEqual(['answer']);
        await api.storage.data.delete('answer');
        expect(await api.storage.data.has('answer')).toBe(false);
    });

    it('never lets a mod widen its own permissions through the frozen manifest', async () => {
        const api = createApi([]);
        try {
            api.manifest.permissions.push('filesystem.data');
        } catch {
            // Frozen in strict mode; either way the gate below must still hold.
        }
        await expect(api.storage.data.get('k')).rejects.toThrow('permission-denied:filesystem.data');
    });
});

describe('mod api file paths (Folium 1.5)', () => {
    const createPathsApi = (permissions: string[]) => {
        const userData = tempDir();
        const filesDir = path.join(userData, 'mods-data', 'test-mod', 'files');
        const cacheDir = path.join(userData, 'mods-cache', 'test-mod');
        return { api: createApi(permissions, { filesDir, cacheDir }), filesDir, cacheDir };
    };

    it('is always there for feature detection, and frozen', () => {
        const { api } = createPathsApi([]);
        expect('paths' in api.storage).toBe(true);
        expect(Object.isFrozen(api.storage.paths)).toBe(true);
    });

    it('throws permission-denied synchronously on read without filesystem.data, creating nothing', () => {
        const { api, filesDir, cacheDir } = createPathsApi([]);
        expect(() => api.storage.paths.data).toThrow('permission-denied:filesystem.data');
        expect(() => api.storage.paths.cache).toThrow('permission-denied:filesystem.data');
        expect(fs.existsSync(filesDir)).toBe(false);
        expect(fs.existsSync(cacheDir)).toBe(false);
    });

    it('returns the absolute directories and creates them on read', () => {
        const { api, filesDir, cacheDir } = createPathsApi(['filesystem.data']);
        expect(api.storage.paths.data).toBe(filesDir);
        expect(api.storage.paths.cache).toBe(cacheDir);
        expect(path.isAbsolute(api.storage.paths.data)).toBe(true);
        expect(fs.statSync(filesDir).isDirectory()).toBe(true);
        expect(fs.statSync(cacheDir).isDirectory()).toBe(true);
    });

    it('re-creates a directory removed since the last read (the user emptied the cache)', () => {
        const { api, cacheDir } = createPathsApi(['filesystem.data']);
        fs.writeFileSync(path.join(api.storage.paths.cache, 'thumb.png'), 'x');
        fs.rmSync(cacheDir, { recursive: true, force: true });
        expect(fs.existsSync(cacheDir)).toBe(false);
        expect(api.storage.paths.cache).toBe(cacheDir);
        expect(fs.statSync(cacheDir).isDirectory()).toBe(true);
    });

    it('cannot be pointed elsewhere by the mod', () => {
        const { api, filesDir } = createPathsApi(['filesystem.data']);
        expect(() => { (api.storage.paths as { data: string }).data = '/elsewhere'; }).toThrow(TypeError);
        expect(api.storage.paths.data).toBe(filesDir);
    });

    // 1.4's api serialized cleanly, so walking it must not read the gated, directory-creating getters.
    it('is skipped when the api is serialized or spread, without the permission', () => {
        const { api, filesDir, cacheDir } = createPathsApi([]);
        expect('data' in api.storage.paths && 'cache' in api.storage.paths).toBe(true);
        expect(Object.keys(api.storage.paths)).toEqual([]);
        expect(JSON.parse(JSON.stringify(api.storage))).toEqual({ data: {}, paths: {} });
        expect(() => JSON.stringify(api)).not.toThrow();
        expect({ ...api.storage.paths }).toEqual({});
        expect(Object.assign({}, api.storage.paths)).toEqual({});
        expect(structuredClone(api.storage.paths)).toEqual({});
        expect(fs.existsSync(filesDir)).toBe(false);
        expect(fs.existsSync(cacheDir)).toBe(false);
    });

    it('creates no directory when the api is serialized, with the permission', () => {
        const { api, filesDir, cacheDir } = createPathsApi(['filesystem.data']);
        expect(JSON.stringify(api.storage.paths)).toBe('{}');
        expect(() => JSON.stringify(api)).not.toThrow();
        expect(fs.existsSync(filesDir)).toBe(false);
        expect(fs.existsSync(cacheDir)).toBe(false);
    });

    /*
     * A stray file where the cache directory should be (or a link whose target is gone): the read
     * fails with the file system's error until the entry goes, which the mods panel's "clear cache"
     * does (clearDirectoryContents removes a root that is not a directory as one entry).
     */
    it('throws while a file stands where the directory should be, and recovers once it is removed', () => {
        const { api, cacheDir } = createPathsApi(['filesystem.data']);
        fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
        fs.writeFileSync(cacheDir, 'stray');
        expect(() => api.storage.paths.cache).toThrow();
        fs.rmSync(cacheDir);
        expect(api.storage.paths.cache).toBe(cacheDir);
        expect(fs.statSync(cacheDir).isDirectory()).toBe(true);
    });
});

describe('mod data store', () => {
    it('serializes overlapping writes so none is lost', async () => {
        const store = createModDataStore(tempDir());
        await Promise.all(Array.from({ length: 20 }, (_, index) => store.set(`k${index}`, index)));
        expect((await store.keys()).length).toBe(20);
    });

    it('refuses a write past the quota and keeps the previous data', async () => {
        const store = createModDataStore(tempDir(), { maxBytes: 64 });
        await store.set('small', 1);
        await expect(store.set('big', 'x'.repeat(200))).rejects.toThrow('storage-quota-exceeded');
        expect(await store.get('small')).toBe(1);
        expect(await store.has('big')).toBe(false);
    });

    it('rejects undefined values and empty keys', async () => {
        const store = createModDataStore(tempDir());
        await expect(store.set('k', undefined)).rejects.toThrow('JSON-serializable');
        await expect(store.get('')).rejects.toThrow('non-empty');
    });

    it('treats prototype names as ordinary keys', async () => {
        const store = createModDataStore(tempDir());
        expect(await store.has('constructor')).toBe(false);
        expect(await store.get('toString')).toBeUndefined();
        await store.set('__proto__', { a: 1 });
        expect(await store.has('__proto__')).toBe(true);
        expect(await store.get('__proto__')).toEqual({ a: 1 });
        expect(await store.keys()).toEqual(['__proto__']);
    });

    it('serializes writes across store instances for the same directory', async () => {
        const dataDir = tempDir();
        const first = createModDataStore(dataDir);
        const second = createModDataStore(dataDir);
        await Promise.all(Array.from({ length: 20 }, (_, index) => (
            (index % 2 ? first : second).set(`k${index}`, index)
        )));
        expect((await first.keys()).length).toBe(20);
    });
});

describe('mod api rpc and host info', () => {
    it('forwards rpc handlers to the loader and validates names', () => {
        const registerRpc = vi.fn();
        const api = createApi([], { registerRpc });
        const handler = async () => 'pong';
        api.rpc.handle('ping', handler);
        expect(registerRpc).toHaveBeenCalledWith('ping', handler);
        expect(() => api.rpc.handle('bad name', handler)).toThrow('rpc.handle');
        expect(() => api.rpc.handle('ok', 'nope')).toThrow('handler function');
    });

    it('exposes the frozen host version info', () => {
        const api = createApi([]);
        expect(api.host).toEqual({ folium: { major: 1, minor: 0 }, folia: '0.7.8' });
        expect(Object.isFrozen(api.host)).toBe(true);
    });

    it('no longer offers command registration on the Node side', () => {
        expect((createApi([]) as Record<string, unknown>).commands).toBeUndefined();
    });
});

describe('mod api lifecycle', () => {
    it('forwards deactivate handlers to the loader', () => {
        const registerDisposer = vi.fn();
        const api = createApi([], { registerDisposer });
        const handler = () => {};
        api.lifecycle.onDeactivate(handler);
        expect(registerDisposer).toHaveBeenCalledWith(handler);
    });
});
