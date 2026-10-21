// src/hooks/useShellNowPlayingBridge.ts
// Bridges Folia playback to a packaged shell's system-level now-playing surface (the HarmonyOS
// shell's AVSession), in both directions:
//
//   page -> shell: one JSON snapshot a second, in the shape the shells already parse.
//   shell -> page: play / pause / prev / next, arriving as a DOM event.
//
// This is deliberately not folded into `useMediaSessionBridge`. That hook owns the W3C Media
// Session, which exists or does not; this one owns a bridge that a particular shell may or may not
// have, and it must still work where `navigator.mediaSession` is missing entirely.
//
// The outputs are the same refs the Media Session uses, so a lock-screen press and an on-screen
// press cannot disagree about what "next" means.

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../types';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';
import {
    isShellNowPlayingSupported,
    publishShellNowPlaying,
    resolveShellArtworkUrl,
    subscribeShellMediaCommands,
} from '../services/shellNowPlaying';

type UseShellNowPlayingBridgeOptions = {
    audioRef: RefObject<HTMLAudioElement | null>;
    /** The deck the displayed track is playing on, or null when the picture is live. */
    getDisplayAudioElement?: () => HTMLAudioElement | null;
    currentSong: SongResult | null;
    cachedCoverUrl: string | null;
    playerState: PlayerState;
    /**
     * A live stage session owns the panel instead of the main queue. Media Session already
     * publishes `playbackState = 'none'` for that window; the shell mirror follows the same rule
     * rather than showing one transport while another one is audible.
     */
    isNowPlayingStageActive: boolean;
    unknownArtistLabel: string;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
};

/**
 * The system extrapolates position from the last (position, updateTime) pair, so pushing once a
 * second keeps the scrubber honest without a bridge call per frame - which on a phone is the
 * difference between a mirror and a stutter.
 */
const SNAPSHOT_INTERVAL_MS = 1000;

export const useShellNowPlayingBridge = ({
    audioRef,
    getDisplayAudioElement,
    currentSong,
    cachedCoverUrl,
    playerState,
    isNowPlayingStageActive,
    unknownArtistLabel,
    mediaSessionPlayRef,
    mediaSessionPauseRef,
    mediaSessionPrevRef,
    mediaSessionNextRef,
    isNowPlayingControlDisabledRef,
}: UseShellNowPlayingBridgeOptions) => {
    useEffect(() => subscribeShellMediaCommands((command) => {
        if (isNowPlayingControlDisabledRef.current) {
            return;
        }

        if (command.command === 'play') {
            Promise.resolve(mediaSessionPlayRef.current()).catch((e) => {
                console.error('Shell media play failed', e);
            });
            return;
        }
        if (command.command === 'pause') {
            mediaSessionPauseRef.current();
            return;
        }
        if (command.command === 'prev') {
            mediaSessionPrevRef.current();
            return;
        }
        void mediaSessionNextRef.current();
    }), [
        isNowPlayingControlDisabledRef,
        mediaSessionNextRef,
        mediaSessionPauseRef,
        mediaSessionPlayRef,
        mediaSessionPrevRef,
    ]);

    useEffect(() => {
        if (!isShellNowPlayingSupported()) {
            return;
        }

        const publish = () => {
            // `hasTrack: false` is not a no-op: it is how the shell learns to drop the card.
            if (!currentSong || isNowPlayingStageActive) {
                publishShellNowPlaying({
                    hasTrack: false,
                    playing: false,
                    title: '',
                    artist: '',
                    album: '',
                    durationSec: 0,
                    positionSec: 0,
                    artworkUrl: '',
                });
                return;
            }

            const audio = getDisplayAudioElement?.() ?? audioRef.current;
            const duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
            const position = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

            publishShellNowPlaying({
                hasTrack: true,
                playing: playerState === PlayerState.PLAYING,
                title: currentSong.name,
                artist: getSongArtistLabel(currentSong) || unknownArtistLabel,
                album: getSongAlbumLabel(currentSong),
                durationSec: Math.max(0, Math.round(duration)),
                positionSec: Math.max(0, Math.round(position)),
                // 壳自己去下载这张图，所以只能给远端地址（blob: 之类它取不到，见 resolveShellArtworkUrl）。
                artworkUrl: resolveShellArtworkUrl(cachedCoverUrl, getSongCoverUrl(currentSong) || null),
            });
        };

        publish();
        const timer = window.setInterval(publish, SNAPSHOT_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [
        audioRef,
        cachedCoverUrl,
        currentSong,
        getDisplayAudioElement,
        isNowPlayingStageActive,
        playerState,
        unknownArtistLabel,
    ]);
};
