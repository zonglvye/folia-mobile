import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getAudioFromLocalSong,
    getFileFromLocalSong,
    getLocalSongArrayBuffer,
    importLocalFiles,
    removeImportedRoot,
    resyncAllFolders,
    resyncFolder,
} from '@/services/localMusicService';
import {
    deleteDirHandle,
    deleteLocalLibrarySnapshot,
    deleteLocalSong,
    deleteLocalSongs,
    getDirHandles,
    getLocalLibrarySnapshot,
    getLocalSongs,
    saveDirHandles,
    saveLocalLibrarySnapshot,
    saveLocalSong,
    saveLocalSongs,
} from '@/services/db';
import { parseEmbeddedMetadataAsync } from '@/utils/localMetadataWorkerClient';
import { prepareLocalCoverBlob } from '@/services/localCoverAssetService';
import { DEFAULT_LOCAL_LYRIC_FORMAT_ORDER } from '@/utils/lyrics/localLyricFormatOrder';
import { useLyricSettingsStore } from '@/stores/useLyricSettingsStore';
import type { LocalSong } from '@/types';

// test/unit/services/localMusicServiceFileImport.test.ts
// Covers the handle-less import seam: plain File[] in (no FileSystemFileHandle anywhere), grouped roots,
// sidecar lyrics resolved by base path, audio bytes persisted to the local audio store, playback and
// cover extraction reading those bytes back, and file-imported roots refusing a disk rescan.

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
    parseEmbeddedMetadataAsync: vi.fn(),
}));

vi.mock('@/services/localCoverAssetService', () => ({
    prepareLocalCoverBlob: vi.fn(),
    stageLocalCoverAsset: vi.fn(),
}));

// The store itself is exercised by localAudioBinaryStore; here it stands in for the browser's OPFS so the
// import pipeline can be checked without one. Keys are derived exactly like the real store derives them.
const storedAudio = new Map<string, File>();
vi.mock('@/services/localAudioBinaryStore', () => ({
    buildLocalAudioAssetKey: (songId: string, fileName: string) => `local-audio:${songId}:${fileName}`,
    readLocalAudioBinary: vi.fn(async (key: string) => storedAudio.get(key) ?? null),
    writeLocalAudioBinary: vi.fn(async (key: string, value: Blob, fileName: string) => {
        storedAudio.set(key, new File([value], fileName, { type: value.type || 'application/octet-stream' }));
        return { backend: 'opfs', mimeType: value.type || 'application/octet-stream', size: value.size };
    }),
    removeLocalAudioBinary: vi.fn(async (key: string) => {
        storedAudio.delete(key);
    }),
}));

// Minimal File System Access API stand-ins for the one test that still needs a real handle.
class FakeFileHandle {
    kind = 'file' as const;
    name: string;
    private readonly file: File;

    constructor(name: string, content = 'audio', type = 'audio/mpeg', lastModified = 1000) {
        this.name = name;
        this.file = new File([content], name, { type, lastModified });
    }

    async getFile() {
        return this.file;
    }
}

class FakeDirectoryHandle {
    kind = 'directory' as const;

    constructor(public name: string, private readonly entries: Array<FakeDirectoryHandle | FakeFileHandle>) {}

    async *values() {
        for (const entry of this.entries) yield entry;
    }

    async getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
        const entry = this.entries.find(item => item.kind === 'directory' && item.name === name);
        if (!entry || entry.kind !== 'directory') throw new Error(`Missing directory ${name}`);
        return entry;
    }

    async getFileHandle(name: string): Promise<FakeFileHandle> {
        const entry = this.entries.find(item => item.kind === 'file' && item.name === name);
        if (!entry || entry.kind !== 'file') throw new Error(`Missing file ${name}`);
        return entry;
    }

    async queryPermission() {
        return 'granted' as PermissionState;
    }

    async requestPermission() {
        return 'granted' as PermissionState;
    }
}

// A picked File: no FileSystemFileHandle exists for it anywhere in this test.
const pickedFile = (name: string, content = 'audio', type = 'audio/mpeg', relativePath?: string): File => {
    const file = new File([content], name, { type });
    if (relativePath) {
        Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true });
    }
    return file;
};

const createSong = (patch: Partial<LocalSong> = {}): LocalSong => ({
    id: 'local-song',
    fileName: 'Track.mp3',
    filePath: 'Music/Track.mp3',
    title: 'Track',
    titleOrigin: 'import',
    importedMetadata: { title: 'Track', titleSource: 'filename', artistNames: [] },
    duration: 1,
    fileSize: 5,
    fileLastModified: 1000,
    fileSignature: 'Music/Track.mp3::5::1000',
    mimeType: 'audio/mpeg',
    addedAt: 1,
    folderName: 'Music',
    ...patch,
});

describe('localMusicService file import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storedAudio.clear();
        vi.mocked(getLocalSongs).mockResolvedValue([]);
        vi.mocked(getLocalLibrarySnapshot).mockResolvedValue(null);
        vi.mocked(getDirHandles).mockResolvedValue({});
        vi.mocked(saveDirHandles).mockResolvedValue(undefined);
        vi.mocked(saveLocalSongs).mockResolvedValue(undefined);
        vi.mocked(saveLocalSong).mockResolvedValue(undefined);
        vi.mocked(saveLocalLibrarySnapshot).mockResolvedValue(undefined);
        vi.mocked(parseEmbeddedMetadataAsync).mockResolvedValue({ duration: 1, title: 'Parsed' });
        vi.mocked(prepareLocalCoverBlob).mockResolvedValue(null);
        useLyricSettingsStore.setState({ localLyricFormatOrder: [...DEFAULT_LOCAL_LYRIC_FORMAT_ORDER] });

        vi.stubGlobal('window', {
            electron: {},
            dispatchEvent: vi.fn(),
        });
        vi.stubGlobal('CustomEvent', class {
            constructor(public type: string, public init?: CustomEventInit) {}
        });
    });

    it('groups a flat pick under one synthetic root and stores every audio file', async () => {
        const songs = await importLocalFiles([
            pickedFile('First.mp3'),
            pickedFile('Second.mp3'),
            pickedFile('ignore.txt', 'notes', 'text/plain'),
        ]);

        expect(songs.map(song => song.filePath)).toEqual(['Local Import/First.mp3', 'Local Import/Second.mp3']);
        expect(songs.every(song => song.folderName === 'Local Import')).toBe(true);
        expect(songs.every(song => song.fileHandle === undefined)).toBe(true);
        expect(saveDirHandles).not.toHaveBeenCalled();
        expect(saveLocalLibrarySnapshot).not.toHaveBeenCalled();
        expect(storedAudio.size).toBe(2);
        expect(vi.mocked(saveLocalSongs).mock.calls[0][0].map(song => song.filePath))
            .toEqual(['Local Import/First.mp3', 'Local Import/Second.mp3']);
    });

    it('derives the root and the folder from webkitRelativePath, and reads the sidecar lyric of each track', async () => {
        const songs = await importLocalFiles([
            pickedFile('Track 01.mp3', 'audio', 'audio/mpeg', 'My Music/Disc 1/Track 01.mp3'),
            pickedFile('Track 01.lrc', '[00:00.00]sidecar', 'text/plain', 'My Music/Disc 1/Track 01.lrc'),
        ]);

        expect(songs).toHaveLength(1);
        expect(songs[0]).toMatchObject({
            filePath: 'My Music/Disc 1/Track 01.mp3',
            folderName: 'My Music/Disc 1',
            hasLocalLyrics: true,
            localLyricsContent: '[00:00.00]sidecar',
            localLyricsOrigin: 'sidecar',
        });
        expect(storedAudio.has(`local-audio:${songs[0].id}:Track 01.mp3`)).toBe(true);
    });

    it('replaces the previous songs of the same root and drops their stored bytes', async () => {
        const previous = createSong({ id: 'old-song', fileName: 'Old.mp3', filePath: 'Local Import/Old.mp3', folderName: 'Local Import' });
        storedAudio.set(`local-audio:${previous.id}:Old.mp3`, pickedFile('Old.mp3'));
        vi.mocked(getLocalSongs).mockResolvedValue([previous]);

        const songs = await importLocalFiles([pickedFile('New.mp3')]);

        expect(songs).toHaveLength(1);
        expect(songs[0].filePath).toBe('Local Import/New.mp3');
        expect(deleteLocalSong).toHaveBeenCalledWith('old-song');
        expect(storedAudio.has(`local-audio:${previous.id}:Old.mp3`)).toBe(false);
        expect(storedAudio.has(`local-audio:${songs[0].id}:New.mp3`)).toBe(true);
    });

    it('imports nothing when the pick contains no audio file', async () => {
        expect(await importLocalFiles([pickedFile('notes.txt', 'notes', 'text/plain')])).toEqual([]);
        expect(saveLocalSongs).not.toHaveBeenCalled();
        expect(storedAudio.size).toBe(0);
    });

    describe('handle-less playback', () => {
        it('plays, resolves and reads bytes for a song whose only source is the audio store', async () => {
            const songs = await importLocalFiles([pickedFile('Only.mp3', 'stored-audio-bytes')]);
            const song = songs[0];
            vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-audio-store');
            vi.mocked(getDirHandles).mockResolvedValue({});

            expect(await getAudioFromLocalSong(song)).toBe('blob:local-audio-store');
            const file = await getFileFromLocalSong(song);
            expect(file?.name).toBe('Only.mp3');
            expect(await file!.text()).toBe('stored-audio-bytes');
            const storedBytes = await getLocalSongArrayBuffer(song);
            expect(storedBytes).not.toBeNull();
            expect(new TextDecoder().decode(storedBytes!)).toBe('stored-audio-bytes');
        });

        it('returns null instead of throwing when nothing is stored for the song', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const song = createSong({ id: 'never-stored', fileName: 'Gone.mp3', filePath: 'Music/Gone.mp3' });

            expect(await getFileFromLocalSong(song)).toBeNull();
            expect(await getAudioFromLocalSong(song)).toBeNull();
            expect(await getLocalSongArrayBuffer(song)).toBeNull();
            warn.mockRestore();
        });
    });

    describe('file-imported roots are not rescan-able', () => {
        it('refuses a folder resync when no directory handle was ever persisted', async () => {
            vi.mocked(getLocalSongs).mockResolvedValue([
                createSong({ id: 'file-song', folderName: 'Local Import', filePath: 'Local Import/Only.mp3' }),
            ]);

            expect(await resyncFolder('Local Import')).toBeNull();
            expect(await resyncAllFolders()).toBeNull();
            expect(saveLocalLibrarySnapshot).not.toHaveBeenCalled();
        });

        it('skips file-imported roots but still rescans the roots that have a directory handle', async () => {
            const directoryHandle = new FakeDirectoryHandle('Music', [new FakeFileHandle('Track.mp3')]);
            vi.mocked(getDirHandles).mockResolvedValue({ Music: directoryHandle as unknown as FileSystemDirectoryHandle });
            vi.mocked(getLocalSongs).mockResolvedValue([
                createSong({ id: 'file-song', folderName: 'Local Import', filePath: 'Local Import/Only.mp3' }),
                createSong({ id: 'folder-song', folderName: 'Music', filePath: 'Music/Track.mp3' }),
            ]);

            const resynced = await resyncAllFolders();

            expect(resynced?.map(song => song.filePath)).toEqual(['Music/Track.mp3']);
            expect(vi.mocked(saveLocalLibrarySnapshot).mock.calls[0][0]).toMatchObject({ rootFolderName: 'Music' });
        });
    });

    it('releases the persisted bytes of a removed root', async () => {
        const songs = await importLocalFiles([pickedFile('Only.mp3')]);
        const song = songs[0];
        vi.mocked(getLocalSongs).mockResolvedValue([song]);
        expect(storedAudio.has(`local-audio:${song.id}:Only.mp3`)).toBe(true);

        await removeImportedRoot('Local Import');

        expect(deleteLocalSongs).toHaveBeenCalledWith([song.id]);
        expect(deleteDirHandle).toHaveBeenCalledWith('Local Import');
        expect(deleteLocalLibrarySnapshot).toHaveBeenCalledWith('Local Import');
        expect(storedAudio.has(`local-audio:${song.id}:Only.mp3`)).toBe(false);
    });

    it('leaves the artwork path alone when the song already has a folder cover', async () => {
        const folderAssetId = `sha256:${'c'.repeat(64)}`;
        vi.mocked(prepareLocalCoverBlob).mockResolvedValue({ assetId: folderAssetId, blob: new Blob(['cover'], { type: 'image/jpeg' }) });
        const songs = await importLocalFiles([pickedFile('Track.mp3', 'audio', 'audio/mpeg', 'Album/Track.mp3'), pickedFile('cover.jpg', 'cover', 'image/jpeg', 'Album/cover.jpg')]);
        const [song] = songs;

        // A folder cover is resolved from the picked File alone, with no directory handle anywhere.
        expect(song.localCoverAssetId).toBe(folderAssetId);
        expect(song.localCoverSource).toBe('folder');
        expect(storedAudio.has(`local-audio:${song.id}:Track.mp3`)).toBe(true);
        // Metadata was parsed inline (a file-input import has no later scan to fill it in).
        expect(vi.mocked(parseEmbeddedMetadataAsync).mock.calls.every(([, includeCover]) => includeCover === false)).toBe(true);
    });
});
