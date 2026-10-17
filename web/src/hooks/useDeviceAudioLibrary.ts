import { useEffect } from 'react';
import { startDeviceAudioLibrarySync } from '../services/deviceAudioSync';

// src/hooks/useDeviceAudioLibrary.ts
// Runs the launch-time scan of the device's own music collection, once, for the app's lifetime.
// The work itself lives in services/deviceAudioSync: this hook only decides when it happens, so the
// same routine is reachable from the local tab's refresh action without going through React.

/** Call once, from the app root, next to the local-library folder watcher. */
export const useDeviceAudioLibrary = (): void => {
    useEffect(() => {
        let cancelled = false;
        void startDeviceAudioLibrarySync().then(() => {
            // The scan already bails out on its own; this only stops a result from landing after the
            // app root was torn down (StrictMode's double mount, or a reload during the dialog).
            if (cancelled) return;
        });
        return () => {
            cancelled = true;
        };
    }, []);
};
