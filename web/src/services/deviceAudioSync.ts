// src/services/deviceAudioSync.ts
// Reconciles the device's music collection into the local library, so the songs the shell can stream
// become ordinary `LocalSong` rows. That is the whole trick behind "open the app and your music is
// there": nothing downstream of the library - the folder / album / artist grouping, lyric matching,
// playlists, the player - has to know these songs were never imported.
//
// The reconciliation is a merge, not a rebuild. A song that is already in the library keeps every
// field the user produced (a matched lyric, a marked-as-instrumental flag, a chosen lyric source) and
// only has the MediaStore-owned fields refreshed, so re-syncing never costs the user their edits.

import type { LocalSong } from '../types';
import { getLocalSongs, saveLocalSongs } from './db';
import { deleteLocalSong, LOCAL_MUSIC_UPDATED_EVENT } from './localMusicService';
import {
    DEVICE_AUDIO_ROOT_FOLDER,
    DEVICE_AUDIO_ROOT_PATH,
    deviceAudioSongId,
    fetchDeviceAudioLibrary,
    hasDeviceAudioPermission,
    isDeviceAudioLibrarySupported,
    isDeviceAudioSong,
    requestDeviceAudioPermission,
    type DeviceAudioTrack,
} from './deviceAudioLibrary';

export interface DeviceAudioSyncResult {
    created: number;
    updated: number;
    removed: number;
    total: number;
}

const stripExtension = (fileName: string): string => {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
};

/** The MediaStore-owned half of a device song's record, as it should look for this track. */
const deviceFieldsOf = (track: DeviceAudioTrack): Partial<LocalSong> => {
    const taggedTitle = track.title.trim();
    const fallbackTitle = stripExtension(track.fileName) || `设备音乐 ${track.id}`;
    const title = taggedTitle || fallbackTitle;
    const artistNames = track.artist.trim() ? [track.artist.trim()] : [];
    return {
        deviceAudioId: track.id,
        fileName: track.fileName || `${title}.mp3`,
        filePath: `${DEVICE_AUDIO_ROOT_PATH}/${track.id}`,
        folderName: DEVICE_AUDIO_ROOT_FOLDER,
        duration: track.durationMs,
        fileSize: track.size,
        // A device track has no File and therefore no lastModified; the signature still has to change
        // when the underlying file is replaced, which the MediaStore size and id capture well enough.
        fileSignature: `device:${track.id}:${track.size}:${track.durationMs}`,
        mimeType: track.mimeType || 'application/octet-stream',
        addedAt: track.addedAt || Date.now(),
        title,
        titleOrigin: 'import',
        // MediaStore reads the file's own tags, so a title that came from there IS the embedded one;
        // falling back to the file name is the honest label for a track with no tags at all.
        importedMetadata: {
            title,
            titleSource: taggedTitle ? 'embedded' : 'filename',
            artistNames,
            albumName: track.album.trim() || undefined,
        },
    };
};

/**
 * Whether a stored device song already agrees with what MediaStore now reports. Rewriting a record
 * that has not changed would touch the whole local_music table on every launch for a library of
 * thousands of tracks, so the merge skips identical rows instead.
 */
const needsUpdate = (song: LocalSong, next: Partial<LocalSong>): boolean => (
    song.title !== next.title
    || song.fileName !== next.fileName
    || song.duration !== next.duration
    || song.fileSize !== next.fileSize
    || song.mimeType !== next.mimeType
    || song.fileSignature !== next.fileSignature
    || song.importedMetadata?.artistNames?.[0] !== next.importedMetadata?.artistNames?.[0]
    || song.importedMetadata?.albumName !== next.importedMetadata?.albumName
);

/**
 * Merges the device collection into the local library. Returns what changed, or null when the sync
 * was refused because the answer could not be trusted (see below).
 *
 * Deleting is the only destructive part, so it is gated: a "granted" answer that lists nothing while
 * the library still holds device songs is treated as a transient read (MediaStore still scanning
 * after a boot) rather than as "the user deleted all their music". Every other granted answer is
 * authoritative and removes the tracks that are genuinely gone.
 */
export const syncDeviceAudioLibrary = async (
    tracks: readonly DeviceAudioTrack[],
): Promise<DeviceAudioSyncResult | null> => {
    const existing = await getLocalSongs();
    const existingDeviceSongs = existing.filter(isDeviceAudioSong);

    if (tracks.length === 0 && existingDeviceSongs.length > 0) {
        console.warn('[DeviceAudio] Sync skipped: the collection read as empty while the library still '
            + `holds ${existingDeviceSongs.length} device songs.`);
        return null;
    }

    const existingByDeviceId = new Map<number, LocalSong>();
    existingDeviceSongs.forEach(song => existingByDeviceId.set(song.deviceAudioId as number, song));

    const presentIds = new Set<number>();
    const toSave: LocalSong[] = [];
    let created = 0;
    let updated = 0;

    tracks.forEach(track => {
        presentIds.add(track.id);
        const fields = deviceFieldsOf(track);
        const current = existingByDeviceId.get(track.id);
        if (!current) {
            toSave.push({ id: deviceAudioSongId(track.id), ...fields } as LocalSong);
            created += 1;
            return;
        }
        if (needsUpdate(current, fields)) {
            // `...current` first: everything the user produced survives, only MediaStore's own
            // fields are replaced.
            toSave.push({ ...current, ...fields });
            updated += 1;
        }
    });

    const removedSongs = existingDeviceSongs.filter(song => !presentIds.has(song.deviceAudioId as number));

    if (toSave.length > 0) {
        await saveLocalSongs(toSave);
    }
    for (const song of removedSongs) {
        await deleteLocalSong(song.id);
    }

    const result: DeviceAudioSyncResult = {
        created,
        updated,
        removed: removedSongs.length,
        total: tracks.length,
    };
    if (created > 0 || updated > 0 || result.removed > 0) {
        console.log(`[DeviceAudio] Sync: ${created} new, ${updated} updated, ${result.removed} removed `
            + `(of ${tracks.length} on the device).`);
        // The app reloads the local library on this event, the same way a folder scan announces itself.
        window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_UPDATED_EVENT));
    }
    return result;
};

/** How many device-backed songs the library currently holds. */
export const countDeviceAudioSongs = async (): Promise<number> => (
    (await getLocalSongs()).filter(isDeviceAudioSong).length
);

// ---- the two entry points the app calls ------------------------------------------------

const PERMISSION_ASKED_KEY = 'folia-device-audio-permission-asked';

/**
 * Whether the permission dialog has already been shown once. A single "no" has to be remembered:
 * asking on every launch is how an app trains its user to deny it reflexively, and the refresh
 * action stays available as the deliberate way back.
 */
export const wasDeviceAudioPermissionAsked = (): boolean => {
    try {
        return window.localStorage.getItem(PERMISSION_ASKED_KEY) === '1';
    } catch {
        // A blocked localStorage must not make the app re-ask on every launch.
        return true;
    }
};

export const markDeviceAudioPermissionAsked = (): void => {
    try {
        window.localStorage.setItem(PERMISSION_ASKED_KEY, '1');
    } catch {
        // Nothing to do; the flag is an optimisation, not a requirement.
    }
};

/**
 * Fetches the device collection and merges it into the library, asking for the permission first when
 * it is missing. Returns how many songs were added or refreshed.
 *
 * This is what the local tab's refresh action calls, which is the important part: the permission
 * dialog is raised from a click the user just made, and the same gesture doubles as "look for music
 * I added since last time". Returns 0 - never throws - when there is no shell, no permission or
 * nothing to change, because a failed scan must not break the refresh that contains it.
 */
export const refreshDeviceAudioLibrary = async (): Promise<number> => {
    try {
        if (!isDeviceAudioLibrarySupported()) return 0;
        let granted = hasDeviceAudioPermission();
        if (!granted) {
            markDeviceAudioPermissionAsked();
            granted = await requestDeviceAudioPermission();
        }
        if (!granted) {
            console.log('[DeviceAudio] Refresh skipped: the media-read permission is not granted.');
            return 0;
        }
        const result = await fetchDeviceAudioLibrary();
        if (result.status !== 'granted') {
            console.log(`[DeviceAudio] Refresh skipped: collection ${result.status}.`);
            return 0;
        }
        const sync = await syncDeviceAudioLibrary(result.tracks);
        return sync ? sync.created + sync.updated : 0;
    } catch (error) {
        console.error('[DeviceAudio] Refresh failed:', error);
        return 0;
    }
};

/**
 * The launch-time scan: silent by design. It only runs when the permission is already granted, or
 * when the dialog has never been shown - asking once is what makes "open the app and your music is
 * there" true, and never asking twice is what keeps it from becoming noise.
 */
export const startDeviceAudioLibrarySync = async (): Promise<void> => {
    if (!isDeviceAudioLibrarySupported()) return;
    try {
        let granted = hasDeviceAudioPermission();
        if (!granted) {
            if (wasDeviceAudioPermissionAsked()) return;
            markDeviceAudioPermissionAsked();
            granted = await requestDeviceAudioPermission();
        }
        if (!granted) return;
        const result = await fetchDeviceAudioLibrary();
        if (result.status !== 'granted') return;
        await syncDeviceAudioLibrary(result.tracks);
    } catch (error) {
        // A music scan failing is never a reason for the app not to start.
        console.error('[DeviceAudio] Launch scan failed:', error);
    }
};

