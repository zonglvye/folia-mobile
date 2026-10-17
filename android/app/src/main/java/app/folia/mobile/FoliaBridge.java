package app.folia.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * The native bridge exposed to the web page as `window.foliaAndroid`, alongside the desktop
 * build's `window.electron`. The shape follows the desktop bridge on purpose: every method is
 * optional, the page probes for existence before calling, and a failure returns null/false so
 * the page's own try/catch decides what to do.
 *
 * Every method here runs on the WebView's JavaScript bridge thread - never the UI thread - and
 * is synchronous. Anything that touches a View is handed to the activity, which posts it.
 */
public class FoliaBridge {

    private final MainActivity activity;

    public FoliaBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** Returns {versionName, versionCode, packageName}, or null when the package is unreadable. */
    @JavascriptInterface
    public String getAppInfo() {
        try {
            PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            JSONObject payload = new JSONObject();
            payload.put("versionName", info.versionName == null ? "" : info.versionName);
            payload.put("versionCode", info.getLongVersionCode());
            payload.put("packageName", activity.getPackageName());
            return payload.toString();
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** Fullscreen toggle driven by the page's own setting. */
    @JavascriptInterface
    public void setImmersiveMode(boolean enabled) {
        activity.setImmersiveMode(enabled);
    }

    /**
     * Pushes the now-playing snapshot to the foreground service, which owns the media
     * notification and the lock-screen transport. The page is the source of truth for playback
     * state; the shell only mirrors it.
     */
    @JavascriptInterface
    public void setPlaybackSnapshot(String snapshotJson) {
        PlaybackService.handleSnapshotJson(activity.getApplicationContext(), snapshotJson);
    }

    /** Opens the battery-optimisation allowlist prompt, falling back to the settings list. */
    @JavascriptInterface
    public void openBatteryOptimizationSettings() {
        try {
            Intent request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + activity.getPackageName()));
            request.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(request);
        } catch (Exception unsupported) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // Nothing to open on this device; the page reports the failure itself.
            }
        }
    }

    /** Opens the app's system settings page, the entry point for background restrictions. */
    @JavascriptInterface
    public void openAppDetailsSettings() {
        try {
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + activity.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
            // Same as above: a missing settings activity is not worth crashing over.
        }
    }

    /**
     * Whether the device's own music collection is already readable. The page probes this before
     * offering to scan, so a returning user is never asked for a permission they already gave.
     */
    @JavascriptInterface
    public boolean hasAudioPermission() {
        return activity.hasAudioPermission();
    }

    /**
     * Shows the media-read permission dialog. Returns immediately and answers later through the
     * `folia-android-audio-permission` DOM event, because a dialog cannot be resolved inside a
     * synchronous bridge call.
     */
    @JavascriptInterface
    public void requestAudioPermission() {
        activity.requestAudioPermission();
    }

    // Reserved for the next milestone, deliberately absent rather than stubbed so the page's
    // per-method capability probing stays truthful:
    //   pickAudioFolder / listAudioFolderEntries / readAudioChunk  - SAF folder import
    //   consumePendingAudioIntent                                  - audio/* handoff
    //   downloadUpdate / getDownloadProgress / installDownloadedUpdate - self-update
    // Reserved event names the shell will dispatch once those exist:
    //   folia-android-page-ready / -audio-intent / -folder-picked
}
