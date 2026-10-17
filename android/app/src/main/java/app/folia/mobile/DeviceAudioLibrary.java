package app.folia.mobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.Locale;

/**
 * Reads the device's own music collection through MediaStore, and hands the page a stable list of
 * playable tracks. This is the piece that makes "open the app and your music is there" possible at
 * all: the web layer cannot see the filesystem, and the previous answer - a file picker - only ever
 * showed the user the songs they had already thought to select.
 *
 * Two deliberate choices:
 *
 * - Nothing is copied. The shell hands the page a URL that streams the original content:// item,
 *   so importing a 3000-track library costs no disk, no OPFS quota and no wait. The audio never
 *   leaves its original location.
 * - The collection is read, never written. No MediaStore row is inserted or updated, so this
 *   cannot disturb the user's own music database, and uninstalling the app removes nothing.
 *
 * The query is guarded by IS_MUSIC and a 10 second floor. IS_MUSIC is what excludes notifications,
 * alarms and ringtones; the duration floor is what excludes the short UI blips that some vendors
 * still mark as music. Anything genuinely musical is far longer than ten seconds, so the floor
 * cannot hide a real track while it does remove the noise that would otherwise bury the library.
 */
public final class DeviceAudioLibrary {

    /** Permission the query needs. READ_MEDIA_AUDIO replaced the storage permission at API 33. */
    public static final String PERMISSION_AUDIO = "android.permission.READ_MEDIA_AUDIO";

    /** Tracks shorter than this are never music, whatever their IS_MUSIC flag claims. */
    private static final long MIN_DURATION_MS = 10_000L;

    private static final String SORT_ORDER = MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC";

    private DeviceAudioLibrary() {
    }

    /**
     * The permission to request at runtime. API 33 split the old storage permission into per-type
     * ones; asking for READ_EXTERNAL_STORAGE on 33+ is granted but silently ignored, which would
     * look like "the dialog was accepted and nothing happened".
     */
    public static String requiredPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? PERMISSION_AUDIO
                : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    public static boolean hasPermission(Context context) {
        return context.checkSelfPermission(requiredPermission()) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * The whole visible audio collection as {"permission":..., "tracks":[...]}. A denied permission
     * is a normal answer rather than an error, because the page has to tell those two apart: denied
     * means "ask the user", while an error means "this device cannot do it at all".
     */
    public static JSONObject describe(Context context) {
        JSONObject payload = new JSONObject();
        JSONArray tracks = new JSONArray();
        try {
            payload.put("permission", hasPermission(context) ? "granted" : "denied");
            payload.put("tracks", tracks);
            if (!hasPermission(context)) {
                return payload;
            }
            ContentResolver resolver = context.getContentResolver();
            try (Cursor cursor = resolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    projection(),
                    MediaStore.Audio.Media.IS_MUSIC + " != 0 AND "
                            + MediaStore.Audio.Media.SIZE + " > 0 AND "
                            + MediaStore.Audio.Media.DURATION + " >= " + MIN_DURATION_MS,
                    null,
                    SORT_ORDER)) {
                if (cursor == null) {
                    payload.put("permission", "unavailable");
                    return payload;
                }
                int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                int titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int albumIdColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID);
                int durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                int mimeColumn = cursor.getColumnIndex(MediaStore.Audio.Media.MIME_TYPE);
                int nameColumn = cursor.getColumnIndex(MediaStore.Audio.Media.DISPLAY_NAME);
                int dateColumn = cursor.getColumnIndex(MediaStore.Audio.Media.DATE_ADDED);
                int pathColumn = cursor.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH);

                while (cursor.moveToNext()) {
                    JSONObject track = new JSONObject();
                    track.put("id", cursor.getLong(idColumn));
                    track.put("title", textOf(cursor, titleColumn));
                    track.put("artist", textOf(cursor, artistColumn));
                    track.put("album", textOf(cursor, albumColumn));
                    track.put("albumId", cursor.getLong(albumIdColumn));
                    track.put("durationMs", cursor.getLong(durationColumn));
                    track.put("size", cursor.getLong(sizeColumn));
                    track.put("mimeType", textOf(cursor, mimeColumn));
                    track.put("fileName", textOf(cursor, nameColumn));
                    // DATE_ADDED is seconds; the page's addedAt is milliseconds.
                    track.put("addedAt", cursor.getLong(dateColumn) * 1000L);
                    if (pathColumn >= 0 && !cursor.isNull(pathColumn)) {
                        track.put("relativePath", cursor.getString(pathColumn));
                    }
                    tracks.put(track);
                }
            }
        } catch (Exception unreadable) {
            // A vendor MediaStore that rejects the projection must not take the app down with it.
            try {
                payload.put("permission", "unavailable");
                payload.put("error", unreadable.getClass().getSimpleName());
            } catch (Exception ignored) {
                // Nothing further to report.
            }
        }
        return payload;
    }

    /**
     * The content:// URI of one track. Built from the id alone so the page never handles a raw
     * filesystem path and the shell keeps the only mapping.
     */
    public static Uri trackUri(long id) {
        return ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
    }

    /**
     * Album art bytes, or null when this device/album has none. Two APIs because the legacy
     * albumart URI stopped being readable at API 29; loadThumbnail is the supported replacement
     * there, and reading the item's own thumbnail is what gives a usable image on modern devices.
     */
    public static byte[] albumArt(Context context, long albumId) {
        ContentResolver resolver = context.getContentResolver();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Bitmap bitmap = resolver.loadThumbnail(
                        ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId),
                        new Size(512, 512),
                        null);
                if (bitmap == null) {
                    return null;
                }
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output);
                bitmap.recycle();
                return output.toByteArray();
            }
            Uri legacy = Uri.parse("content://media/external/audio/albumart/" + albumId);
            try (java.io.InputStream input = resolver.openInputStream(legacy)) {
                if (input == null) {
                    return null;
                }
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = input.read(buffer)) > 0) {
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        } catch (Exception noArt) {
            // An album without embedded art throws here on several vendors rather than returning null.
            return null;
        }
    }

    /** MIME type MediaStore records for one track, so the player does not have to guess. */
    public static String mimeTypeOf(Context context, long id) {
        String type = null;
        try {
            type = context.getContentResolver().getType(trackUri(id));
        } catch (Exception ignored) {
            // Falls through to the neutral label below.
        }
        return type == null || type.isEmpty() ? "application/octet-stream" : type;
    }

    /** Byte length of one track, used to answer Range requests when the descriptor omits it. */
    public static long sizeOf(Context context, long id) {
        try (Cursor cursor = context.getContentResolver().query(
                trackUri(id),
                new String[]{ MediaStore.Audio.Media.SIZE },
                null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                return cursor.getLong(0);
            }
        } catch (Exception ignored) {
            // Unknown length is handled by the caller as an unbounded stream.
        }
        return -1L;
    }

    private static String[] projection() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new String[]{
                    MediaStore.Audio.Media._ID,
                    MediaStore.Audio.Media.TITLE,
                    MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.ALBUM,
                    MediaStore.Audio.Media.ALBUM_ID,
                    MediaStore.Audio.Media.DURATION,
                    MediaStore.Audio.Media.SIZE,
                    MediaStore.Audio.Media.MIME_TYPE,
                    MediaStore.Audio.Media.DISPLAY_NAME,
                    MediaStore.Audio.Media.DATE_ADDED,
                    MediaStore.Audio.Media.RELATIVE_PATH,
            };
        }
        return new String[]{
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.DATE_ADDED,
        };
    }

    /** MediaStore reports "unknown" as the literal string <unknown>; an empty field is more honest. */
    private static String textOf(Cursor cursor, int column) {
        if (column < 0 || cursor.isNull(column)) {
            return "";
        }
        String value = cursor.getString(column);
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty() || "<unknown>".equalsIgnoreCase(trimmed)) {
            return "";
        }
        return trimmed;
    }

    /** Kept for logging: a locale-stable label for the permission in shell logs. */
    static String permissionLabel() {
        return requiredPermission().toLowerCase(Locale.US);
    }
}
