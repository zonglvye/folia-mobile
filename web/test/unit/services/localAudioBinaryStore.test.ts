import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildLocalAudioAssetKey,
    clearLocalAudioBinaries,
    estimateLocalAudioBinaryUsage,
    hasLocalAudioBinary,
    isValidLocalAudioAssetKey,
    readLocalAudioBinary,
    removeLocalAudioBinary,
    writeLocalAudioBinary,
    isLocalAudioBinaryRuntimeSupported,
} from '@/services/localAudioBinaryStore';

// test/unit/services/localAudioBinaryStore.test.ts
// Covers the OPFS-backed audio byte store: the self-describing key, the descriptor being validated
// against the bytes on disk, and the write / read / has / remove / clear / usage surface.

// A minimal in-memory OPFS: one flat map of entries, the way the store uses it (binary/text reads for a
// descriptor, a writable for a write, a recursive remove for a clear).
type FakeEntry = { bytes: Uint8Array };

const concatBytes = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(new ArrayBuffer(total)) as Uint8Array<ArrayBuffer>;
    let offset = 0;
    chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    });
    return result;
};

// A BlobPart as the fake stores it: bytes for a blob, the encoded text for a string.
const entryBytes = async (value: unknown): Promise<Uint8Array> => {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value && typeof (value as Blob).arrayBuffer === 'function') {
        return new Uint8Array(await (value as Blob).arrayBuffer());
    }
    return new Uint8Array(0);
};

class FakeOpfsFileHandle {
    kind = 'file' as const;

    constructor(public name: string, private readonly entries: Map<string, FakeEntry>) {}

    async getFile() {
        const entry = this.entries.get(this.name);
        if (!entry) throw new Error(`Missing file ${this.name}`);
        const { bytes } = entry;
        return new File([new Uint8Array(bytes)], this.name, { lastModified: 1234 });
    }

    async createWritable() {
        const chunks: Uint8Array[] = [];
        return {
            write: async (value: unknown) => {
                chunks.push(await entryBytes(value));
            },
            close: async () => {
                this.entries.set(this.name, { bytes: concatBytes(chunks) });
            },
            abort: async () => undefined,
        };
    }
}

class FakeOpfsDirectoryHandle {
    kind = 'directory' as const;

    constructor(public name: string, private readonly entries: Map<string, FakeEntry>) {}

    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const isKnown = name === 'folia-cache' || name === 'local-audio-assets';
        if (!isKnown && !options?.create) throw new Error(`Missing directory ${name}`);
        return new FakeOpfsDirectoryHandle(name, this.entries);
    }

    async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!this.entries.has(name) && !options?.create) throw new Error(`Missing file ${name}`);
        return new FakeOpfsFileHandle(name, this.entries);
    }

    async removeEntry(name: string, options?: { recursive?: boolean }) {
        // The fake keeps every file in one map, so a recursive clear of the audio directory drops them
        // all - which is what the real, per-directory OPFS layout amounts to.
        if (name === 'local-audio-assets' && options?.recursive) {
            this.entries.clear();
            return;
        }
        if (!this.entries.delete(name)) throw new Error(`Missing entry ${name}`);
    }

    async *values() {
        for (const name of [...this.entries.keys()]) {
            yield new FakeOpfsFileHandle(name, this.entries);
        }
    }
}

const KEY = buildLocalAudioAssetKey('local_1700000000000_abcd1234', 'Track 01.mp3')!;
const storedFile = (content: string, fileName: string, type: string) => new File([content], fileName, { type });

let entries: Map<string, FakeEntry>;

const entriesText = (name: string) => {
    const entry = entries.get(name);
    return entry ? new TextDecoder().decode(entry.bytes) : '';
};

// Overwrites the descriptor half of an entry, to check the validation against the bytes on disk.
const writeDescriptor = async (key: string, descriptor: Record<string, unknown>) => {
    entries.set(`${key}.json`, { bytes: new TextEncoder().encode(JSON.stringify(descriptor)) });
};

const readDescriptor = (key: string) => JSON.parse(entriesText(`${key}.json`));

describe('localAudioBinaryStore', () => {
    beforeEach(() => {
        entries = new Map();
        vi.stubGlobal('window', {
            isSecureContext: true,
            location: { protocol: 'https:', hostname: 'example.com' },
        });
        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: vi.fn(async () => new FakeOpfsDirectoryHandle('root', entries)) },
            configurable: true,
        });
    });

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'storage');
        vi.unstubAllGlobals();
    });

    it('reports an unsupported runtime without the storage directory API', () => {
        Reflect.deleteProperty(navigator, 'storage');
        expect(isLocalAudioBinaryRuntimeSupported()).toBe(false);
    });

    it('reports an unsupported runtime under the Electron bridge', () => {
        (window as unknown as { electron?: unknown; }).electron = {};
        expect(isLocalAudioBinaryRuntimeSupported()).toBe(false);
        Reflect.deleteProperty(window, 'electron');
    });

    it('builds a self-describing key from the song id and the file name and validates it', () => {
        expect(KEY).toBe('local-audio:local_1700000000000_abcd1234:Track 01.mp3');
        expect(isValidLocalAudioAssetKey(KEY)).toBe(true);
        // A path separator is folded into the entry name instead of creating a nested path.
        expect(buildLocalAudioAssetKey('local_1700000000000_abcd1234', 'Disc 1/Track.mp3'))
            .toBe('local-audio:local_1700000000000_abcd1234:Disc 1_Track.mp3');
        expect(isValidLocalAudioAssetKey('local-audio:not-an-id:Track.mp3')).toBe(false);
        expect(isValidLocalAudioAssetKey('local-audio:local_1_abc:a/b.mp3')).toBe(false);
        expect(isValidLocalAudioAssetKey('sha256:' + 'a'.repeat(64))).toBe(false);
    });

    it('writes bytes plus a descriptor and reads them back with the stored name and type', async () => {
        const source = storedFile('audio-bytes', 'Track 01.mp3', 'audio/mpeg');

        expect(await writeLocalAudioBinary(KEY, source, 'Track 01.mp3')).toEqual({
            backend: 'opfs',
            mimeType: 'audio/mpeg',
            size: source.size,
        });
        expect(entries.has(`${KEY}.bin`)).toBe(true);
        expect(entries.has(`${KEY}.json`)).toBe(true);

        const read = await readLocalAudioBinary(KEY);
        expect(read).toBeInstanceOf(File);
        expect(read!.name).toBe('Track 01.mp3');
        expect(read!.type).toBe('audio/mpeg');
        expect(read!.size).toBe(source.size);
        expect(await read!.text()).toBe('audio-bytes');
        expect(await hasLocalAudioBinary(KEY)).toBe(true);
    });

    it('keeps an unknown blob type as a neutral binary label instead of refusing the write', async () => {
        const source = storedFile('audio-bytes', 'Track.ape', '');
        expect(await writeLocalAudioBinary(KEY, source, 'Track.ape')).toMatchObject({ mimeType: 'application/octet-stream' });
        expect((await readLocalAudioBinary(KEY))!.type).toBe('application/octet-stream');
    });

    it('refuses a key it cannot name an entry with, and empty bytes', async () => {
        expect(await writeLocalAudioBinary('not-a-key', storedFile('x', 'x.mp3', 'audio/mpeg'), 'x.mp3')).toBeNull();
        expect(await writeLocalAudioBinary(KEY, new Blob([]), 'x.mp3')).toBeNull();
        expect(await writeLocalAudioBinary(KEY, 'not a blob', 'x.mp3')).toBeNull();
        expect(entries.size).toBe(0);
    });

    it('treats a descriptor that disagrees with the bytes on disk as absent', async () => {
        await writeLocalAudioBinary(KEY, storedFile('audio-bytes', 'Track 01.mp3', 'audio/mpeg'), 'Track 01.mp3');
        const validDescriptor = readDescriptor(KEY);

        // Wrong size.
        await writeDescriptor(KEY, { ...validDescriptor, size: validDescriptor.size + 1 });
        expect(await hasLocalAudioBinary(KEY)).toBe(false);
        expect(await readLocalAudioBinary(KEY)).toBeNull();

        // Wrong key.
        await writeDescriptor(KEY, { ...validDescriptor, key: 'local-audio:local_1700000000001_beef1234:Other.mp3' });
        expect(await hasLocalAudioBinary(KEY)).toBe(false);

        // MIME type outside the allowlist.
        await writeDescriptor(KEY, { ...validDescriptor, mimeType: 'text/html' });
        expect(await hasLocalAudioBinary(KEY)).toBe(false);

        // No file name to rebuild the File with.
        await writeDescriptor(KEY, { ...validDescriptor, fileName: '' });
        expect(await hasLocalAudioBinary(KEY)).toBe(false);

        // Restored descriptor: readable again.
        await writeDescriptor(KEY, validDescriptor);
        expect(await hasLocalAudioBinary(KEY)).toBe(true);
    });

    it('reports a missing or unparsable entry as absent instead of throwing', async () => {
        expect(await readLocalAudioBinary(KEY)).toBeNull();
        expect(await hasLocalAudioBinary(KEY)).toBe(false);

        entries.set(`${KEY}.bin`, { bytes: new TextEncoder().encode('audio-bytes') });
        entries.set(`${KEY}.json`, { bytes: new TextEncoder().encode('{ not json') });
        expect(await readLocalAudioBinary(KEY)).toBeNull();
    });

    it('removes both halves of an entry and clears the whole directory', async () => {
        await writeLocalAudioBinary(KEY, storedFile('audio-bytes', 'Track 01.mp3', 'audio/mpeg'), 'Track 01.mp3');
        await removeLocalAudioBinary(KEY);
        expect(entries.size).toBe(0);
        // Removing something already gone is not an error.
        await expect(removeLocalAudioBinary(KEY)).resolves.toBeUndefined();

        await writeLocalAudioBinary(KEY, storedFile('audio-bytes', 'Track 01.mp3', 'audio/mpeg'), 'Track 01.mp3');
        await clearLocalAudioBinaries();
        expect(entries.size).toBe(0);
    });

    it('estimates the bytes held, descriptors included', async () => {
        expect(await estimateLocalAudioBinaryUsage()).toBe(0);
        const otherKey = buildLocalAudioAssetKey('local_1700000000001_beef1234', 'Other.mp3')!;
        const first = storedFile('audio-bytes', 'Track 01.mp3', 'audio/mpeg');
        const second = storedFile('more-bytes', 'Other.mp3', 'audio/mpeg');
        await writeLocalAudioBinary(KEY, first, 'Track 01.mp3');
        await writeLocalAudioBinary(otherKey, second, 'Other.mp3');

        const expected = [...entries.values()].reduce((total, entry) => total + entry.bytes.byteLength, 0);
        expect(await estimateLocalAudioBinaryUsage()).toBe(expected);
        expect(expected).toBeGreaterThan(first.size + second.size);
    });
});
