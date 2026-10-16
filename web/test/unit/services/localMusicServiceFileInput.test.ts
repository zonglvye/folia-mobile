// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importLocalFilesViaInput } from '@/services/localMusicService';
import {
    deleteLocalSong,
    getDirHandles,
    getLocalLibrarySnapshot,
    getLocalSongs,
    saveLocalLibrarySnapshot,
    saveLocalSongs,
} from '@/services/db';
import { parseEmbeddedMetadataAsync } from '@/utils/localMetadataWorkerClient';

// test/unit/services/localMusicServiceFileInput.test.ts
// Covers the picker itself: the hidden multi-select input it opens (and the directory attributes it must
// not set), the cancel path that resolves with no songs, and the picked-files path that hands the files
// to the handle-less import.

vi.mock('@/services/db', () => ({
    deleteDirHandle: vi.fn(),
    deleteLocalLibrarySnapshot: vi.fn(),
    deleteLocalSong: vi.fn(),
    deleteLocalSongs: vi.fn(),
    getDirHandles: vi.fn(),
    getFromCache: vi.fn(),
    getLocalLibrarySnapshot: vi.fn(),
    getLocalSongs: vi.fn(),
    saveDirHandles: vi.fn(),
    saveLocalLibrarySnapshot: vi.fn(),
    saveLocalSong: vi.fn(),
    saveLocalSongs: vi.fn(),
    saveToCache: vi.fn(),
}));

vi.mock('@/services/coverCache', () => ({
    removeCachedCover: vi.fn(),
}));

vi.mock('@/utils/localMetadataWorkerClient', () => ({
    parseEmbeddedMetadataAsync: vi.fn(async () => ({ duration: 1 })),
}));

vi.mock('@/services/localCoverAssetService', () => ({
    prepareLocalCoverBlob: vi.fn(async () => null),
    stageLocalCoverAsset: vi.fn(),
}));

// jsdom has no OPFS; the store is covered on its own, and here it only has to accept the bytes.
vi.mock('@/services/localAudioBinaryStore', () => ({
    buildLocalAudioAssetKey: (songId: string, fileName: string) => `local-audio:${songId}:${fileName}`,
    readLocalAudioBinary: vi.fn(async () => null),
    writeLocalAudioBinary: vi.fn(async (_key: string, value: Blob) => ({
        backend: 'opfs',
        mimeType: value.type || 'application/octet-stream',
        size: value.size,
    })),
    removeLocalAudioBinary: vi.fn(async () => undefined),
}));

const pickedFile = (name: string): File => new File(['audio'], name, { type: 'audio/mpeg' });

// The component under test appends its input and clicks it; this intercepts both and records each one.
const openPicker = (): { get input(): HTMLInputElement; } => {
    const created: HTMLInputElement[] = [];
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
        const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName) as HTMLInputElement;
        if (tagName === 'input') {
            element.click = () => undefined;
            created.push(element);
        }
        return element;
    }) as typeof document.createElement);
    return {
        get input() {
            const latest = created.at(-1);
            if (!latest) throw new Error('The picker did not create an input element.');
            return latest;
        },
    };
};

describe('importLocalFilesViaInput', () => {
    let picker: { get input(): HTMLInputElement; };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getLocalSongs).mockResolvedValue([]);
        vi.mocked(getLocalLibrarySnapshot).mockResolvedValue(null);
        vi.mocked(getDirHandles).mockResolvedValue({});
        vi.mocked(saveLocalSongs).mockResolvedValue(undefined);
        vi.mocked(saveLocalLibrarySnapshot).mockResolvedValue(undefined);
        vi.mocked(parseEmbeddedMetadataAsync).mockResolvedValue({ duration: 1 });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        picker = openPicker();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('opens a hidden multi-select input without webkitdirectory', async () => {
        const pending = importLocalFilesViaInput();
        const { input } = picker;

        expect(input.type).toBe('file');
        expect(input.multiple).toBe(true);
        expect(input.accept).toBe('audio/*,.lrc,.vtt,.ttml,.qrc,.yrc,.krc');
        // Android Chromium silently ignores webkitdirectory and hands back an unreadable tree, so it
        // must not be set.
        expect(input.hasAttribute('webkitdirectory')).toBe(false);
        expect(input.style.display).toBe('none');
        expect(document.body.contains(input)).toBe(true);

        input.dispatchEvent(new Event('cancel'));
        await pending;
        expect(document.body.contains(input)).toBe(false);
    });

    it('resolves with no songs when the picker is dismissed', async () => {
        const pending = importLocalFilesViaInput();
        const { input } = picker;
        input.dispatchEvent(new Event('cancel'));

        expect(await pending).toEqual([]);
        expect(saveLocalSongs).not.toHaveBeenCalled();
        expect(document.body.contains(input)).toBe(false);
    });

    it('imports the picked files and resolves with the created songs', async () => {
        const pending = importLocalFilesViaInput();
        Object.defineProperty(picker.input, 'files', { value: [pickedFile('First.mp3'), pickedFile('Second.mp3')], configurable: true });
        picker.input.dispatchEvent(new Event('change'));

        const songs = await pending;

        expect(songs.map(song => song.filePath)).toEqual(['Local Import/First.mp3', 'Local Import/Second.mp3']);
        expect(vi.mocked(saveLocalSongs).mock.calls[0][0]).toHaveLength(2);
        expect(deleteLocalSong).not.toHaveBeenCalled();
        expect(document.body.contains(picker.input)).toBe(false);
    });

    it('imports once and ignores a later event', async () => {
        const once = importLocalFilesViaInput();
        const { input } = picker;
        Object.defineProperty(input, 'files', { value: [pickedFile('Only.mp3')], configurable: true });
        input.dispatchEvent(new Event('change'));

        expect((await once).map(song => song.fileName)).toEqual(['Only.mp3']);
        expect(vi.mocked(saveLocalSongs)).toHaveBeenCalledTimes(1);

        // The input is gone by now, so a second event must not start another import.
        input.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(vi.mocked(saveLocalSongs)).toHaveBeenCalledTimes(1);
    });

    it('imports nothing when the selection is empty', async () => {
        const empty = importLocalFilesViaInput();
        Object.defineProperty(picker.input, 'files', { value: [], configurable: true });
        picker.input.dispatchEvent(new Event('change'));

        expect(await empty).toEqual([]);
        expect(saveLocalSongs).not.toHaveBeenCalled();
    });
});
