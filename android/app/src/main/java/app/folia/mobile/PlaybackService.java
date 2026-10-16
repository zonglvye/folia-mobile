package app.folia.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Background playback: a foreground service that owns a MediaSession and the media
 * notification, while the audio itself keeps playing inside the WebView.
 *
 * The single most important rule in this file: the service never requests audio focus. Focus
 * belongs to the WebView's own Chromium media stack; a second owner on the native side takes
 * it away from the page, the page receives AUDIOFOCUS_LOSS and auto-pauses, and the symptom is
 * "playback stops the instant you press play". The service's job is narrower than it looks:
 *
 *   1. raise the process to foreground priority so backgrounding does not get playback killed;
 *   2. surface transport controls on the notification shade and lock screen;
 *   3. translate system events (headset unplug, voice search) into commands for the page.
 *
 * Data flow: page -> setPlaybackSnapshot -> this service (notification + MediaSession);
 * transport actions -> onStartCommand / MediaSession callback -> dispatchCommand -> the page's
 * `folia-android-media-command` DOM event.
 */
public class PlaybackService extends Service {

    private static final String TAG = "FoliaShell";

    public static final String ACTION_PLAY = "app.folia.mobile.action.PLAY";
    public static final String ACTION_PAUSE = "app.folia.mobile.action.PAUSE";
    public static final String ACTION_PREVIOUS = "app.folia.mobile.action.PREVIOUS";
    public static final String ACTION_NEXT = "app.folia.mobile.action.NEXT";

    /**
     * IMPORTANCE_DEFAULT rather than the "correct" IMPORTANCE_LOW: many OEM skins fold or hide
     * low-importance notifications from the lock screen, which makes the media card appear and
     * disappear at random. Sound is explicitly nulled and onlyAlertOnce is set, so DEFAULT
     * costs nothing beyond the first heads-up.
     *
     * Channel importance is immutable after creation, so a change to it requires a new channel
     * id; the old one is deleted to avoid a duplicate entry in system settings.
     */
    private static final String CHANNEL_ID = "folia_playback_v2";
    private static final String LEGACY_CHANNEL_ID = "folia_playback";
    private static final int NOTIFICATION_ID = 42;

    /** Command sink back into the page; registered by MainActivity, cleared when it is destroyed. */
    public interface MediaCommandSink {
        void onMediaCommand(String payloadJson);
    }

    private static volatile MediaCommandSink commandSink;
    private static volatile PlaybackService instance;

    private static final Object SNAPSHOT_LOCK = new Object();
    private static String pendingSnapshotJson;

    public static void setCommandSink(MediaCommandSink sink) {
        commandSink = sink;
    }

    /**
     * Entry point for the bridge. Records the snapshot and starts or refreshes the service.
     * Runs on the JavaScript bridge thread, which is why the snapshot is guarded by a lock.
     */
    public static void handleSnapshotJson(Context context, String json) {
        synchronized (SNAPSHOT_LOCK) {
            pendingSnapshotJson = json;
        }
        boolean hasTrack = false;
        try {
            hasTrack = new JSONObject(json == null ? "{}" : json).optBoolean("hasTrack", false);
        } catch (Exception malformed) {
            hasTrack = false;
        }
        PlaybackService current = instance;
        if (hasTrack && current == null) {
            Intent intent = new Intent(context, PlaybackService.class);
            // startForegroundService is unconditional at minSdk 26.
            context.startForegroundService(intent);
        } else if (current != null) {
            current.refreshFromSnapshot();
        }
    }

    private static void dispatchJson(String json) {
        MediaCommandSink sink = commandSink;
        if (sink != null) {
            sink.onMediaCommand(json);
        }
    }

    private static void dispatchCommand(String command) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("command", command);
            dispatchJson(payload.toString());
        } catch (Exception ignored) {
            // A command that cannot be serialised is dropped; nothing to report to the page.
        }
    }

    /** Seek from the lock-screen scrubber: MediaSession speaks milliseconds, the page speaks seconds. */
    private static void dispatchSeek(long positionSec) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("command", "seek");
            payload.put("positionSec", Math.max(0, positionSec));
            dispatchJson(payload.toString());
        } catch (Exception ignored) {
            // Same as above.
        }
    }

    private static void dispatchSearch(String query, String focus) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("command", "search");
            payload.put("query", query);
            if (focus != null && !focus.isEmpty()) {
                payload.put("focus", focus);
            }
            dispatchJson(payload.toString());
        } catch (Exception ignored) {
            // Same as above.
        }
    }

    // ---- mirrored playback state (main thread only) ------------------------------------

    private boolean playing;
    private String title = "";
    private String artist = "";
    private String album = "";
    private long durationSec;
    private long positionSec;
    private String artworkUrl = "";
    private String currentLyricLine = "";

    /** Artwork url already loaded or loading; null means never attempted. */
    private String loadedArtworkUrl;
    private Bitmap artworkBitmap;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private MediaSession mediaSession;
    private BroadcastReceiver noisyReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        mediaSession = new MediaSession(this, "FoliaPlayback");
        mediaSession.setActive(true);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                dispatchCommand("play");
            }

            @Override
            public void onPause() {
                dispatchCommand("pause");
            }

            @Override
            public void onSkipToPrevious() {
                dispatchCommand("prev");
            }

            @Override
            public void onSkipToNext() {
                dispatchCommand("next");
            }

            @Override
            public void onSeekTo(long positionMs) {
                dispatchSeek(positionMs / 1000);
            }

            @Override
            public void onPlayFromSearch(String query, Bundle extras) {
                // Voice assistants land here. An empty query (the user only said "play")
                // degrades to resuming rather than searching for nothing.
                if (query == null || query.trim().isEmpty()) {
                    dispatchCommand("play");
                    return;
                }
                String focus = extras == null ? null : extras.getString(MediaStore.EXTRA_MEDIA_FOCUS);
                dispatchSearch(query.trim(), focus);
            }
        });

        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(R.string.notification_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(getString(R.string.notification_channel_description));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
        manager.deleteNotificationChannel(LEGACY_CHANNEL_ID);

        applySnapshotState();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_PLAY.equals(action)) {
            dispatchCommand("play");
        } else if (ACTION_PAUSE.equals(action)) {
            dispatchCommand("pause");
        } else if (ACTION_PREVIOUS.equals(action)) {
            dispatchCommand("prev");
        } else if (ACTION_NEXT.equals(action)) {
            dispatchCommand("next");
        }
        applySnapshotState();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        // Swiping the task away must not stop playback - that is the point of a foreground
        // service. The page tells the service to stop by pushing a snapshot with no track.
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        artworkExecutor.shutdownNow();
        artworkBitmap = null;
        unregisterNoisyReceiver();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    private void refreshFromSnapshot() {
        mainHandler.post(this::applySnapshotState);
    }

    private void applySnapshotState() {
        String json;
        synchronized (SNAPSHOT_LOCK) {
            json = pendingSnapshotJson;
        }

        boolean hasTrack = false;
        try {
            JSONObject snapshot = new JSONObject(json == null ? "{}" : json);
            hasTrack = snapshot.optBoolean("hasTrack", false);
            if (!hasTrack) {
                // No track: drop the notification and return the process to normal priority.
                playing = false;
                unregisterNoisyReceiver();
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return;
            }
            boolean wasPlaying = playing;
            playing = snapshot.optBoolean("playing", false);
            title = snapshot.optString("title", "");
            artist = snapshot.optString("artist", "");
            album = snapshot.optString("album", "");
            durationSec = Math.max(0, snapshot.optLong("durationSec", 0));
            positionSec = Math.max(0, snapshot.optLong("positionSec", 0));
            artworkUrl = snapshot.optString("artworkUrl", "");
            currentLyricLine = snapshot.optString("currentLyricLine", "");
            if (playing != wasPlaying) {
                if (playing) {
                    registerNoisyReceiver();
                } else {
                    unregisterNoisyReceiver();
                }
            }
        } catch (Exception malformed) {
            Log.w(TAG, "Ignoring malformed playback snapshot");
            return;
        }

        loadArtworkIfNeeded();
        updateMediaSession();
        startForegroundWithNotification();
    }

    private void updateMediaSession() {
        if (mediaSession == null) {
            return;
        }
        // While playing, the second line shows the live lyric instead of the artist: OEM media
        // cards and control centres read this straight from the MediaSession metadata.
        boolean showLyric = playing && currentLyricLine != null && !currentLyricLine.isEmpty();
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? "Folia" : title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, showLyric ? currentLyricLine : artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationSec * 1000L);
        if (artworkBitmap != null && !artworkBitmap.isRecycled()) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artworkBitmap);
        }
        mediaSession.setMetadata(metadata.build());

        // ACTION_SEEK_TO must be declared or the system shows no scrubber and never calls
        // onSeekTo. Position and speed are refreshed with every snapshot; the system
        // extrapolates between them.
        PlaybackState.Builder state = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_SEEK_TO
                        | PlaybackState.ACTION_PLAY_FROM_SEARCH);
        long positionMs = positionSec * 1000L;
        if (playing) {
            state.setState(PlaybackState.STATE_PLAYING, positionMs, 1f);
        } else {
            state.setState(PlaybackState.STATE_PAUSED, positionMs, 0f);
        }
        mediaSession.setPlaybackState(state.build());
    }

    /** Re-fetches artwork only when the URL changes; a failure is not retried until the track does. */
    private void loadArtworkIfNeeded() {
        String url = artworkUrl == null ? "" : artworkUrl;
        if (url.isEmpty()) {
            if (loadedArtworkUrl != null && !loadedArtworkUrl.isEmpty()) {
                loadedArtworkUrl = "";
                artworkBitmap = null;
                updateMediaSession();
                startForegroundWithNotification();
            }
            return;
        }
        if (url.equals(loadedArtworkUrl)) {
            return;
        }
        loadedArtworkUrl = url;
        artworkExecutor.execute(() -> {
            Bitmap decoded = null;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setInstanceFollowRedirects(true);
                decoded = BitmapFactory.decodeStream(connection.getInputStream());
            } catch (Exception failed) {
                Log.w(TAG, "Artwork load failed: " + url);
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
            final Bitmap result = decoded;
            mainHandler.post(() -> {
                if (instance != this) {
                    return;
                }
                artworkBitmap = result;
                updateMediaSession();
                startForegroundWithNotification();
            });
        });
    }

    private void startForegroundWithNotification() {
        if (mediaSession == null) {
            return;
        }
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        int playPauseIcon = playing
                ? android.R.drawable.ic_media_pause
                : android.R.drawable.ic_media_play;
        String playPauseLabel = playing ? "暂停" : "播放";

        boolean showLyric = playing && currentLyricLine != null && !currentLyricLine.isEmpty();
        String contentText = showLyric
                ? currentLyricLine
                : (playing
                        ? artist
                        : (artist.isEmpty() ? "已暂停" : artist + " · 已暂停"));

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                // CATEGORY_TRANSPORT is how a ROM recognises this as a media card and ranks it
                // with the lock-screen transport controls.
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setContentTitle(title.isEmpty() ? "Folia" : title)
                .setContentText(contentText)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                        "上一首", actionPendingIntent(ACTION_PREVIOUS, 1)).build())
                .addAction(new Notification.Action.Builder(playPauseIcon, playPauseLabel,
                        actionPendingIntent(playing ? ACTION_PAUSE : ACTION_PLAY, 2)).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                        "下一首", actionPendingIntent(ACTION_NEXT, 3)).build());

        if (artworkBitmap != null && !artworkBitmap.isRecycled()) {
            builder.setLargeIcon(artworkBitmap);
        }

        Notification.MediaStyle style = new Notification.MediaStyle();
        if (mediaSession != null) {
            style.setMediaSession(mediaSession.getSessionToken());
        }
        style.setShowActionsInCompactView(0, 1, 2);
        builder.setStyle(style);
        return builder.build();
    }

    private PendingIntent actionPendingIntent(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Headphones unplugged or Bluetooth audio dropped: pause instead of blasting the speaker. */
    private void registerNoisyReceiver() {
        if (noisyReceiver != null) {
            return;
        }
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                dispatchCommand("pause");
            }
        };
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(noisyReceiver, filter);
        }
    }

    private void unregisterNoisyReceiver() {
        if (noisyReceiver == null) {
            return;
        }
        try {
            unregisterReceiver(noisyReceiver);
        } catch (Exception alreadyGone) {
            // Unregistering twice is harmless.
        }
        noisyReceiver = null;
    }
}
