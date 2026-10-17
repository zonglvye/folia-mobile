package app.folia.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the device's own music library to the page over the virtual origin, so the web layer never
 * touches a content:// URI and never needs a File object for a track it did not import.
 *
 * Three routes:
 *   GET /api/device-audio          - the whole collection as JSON (see DeviceAudioLibrary)
 *   GET /api/device-audio/stream   - one track's bytes, with Range support
 *   GET /api/device-audio/cover    - one album's art, or 404 when it has none
 *
 * Range is the reason this class exists rather than a one-line hand-off. A media element seeks by
 * asking for a byte range; if the response cannot answer one, the position bar looks alive but every
 * drag either restarts the track or leaves it silent. So the full 206 contract is implemented here:
 * Accept-Ranges on the 200, Content-Range on the 206, and a 416 that names the real length when the
 * requested offset is past the end. Seeking is not an optimisation on a player like this one.
 *
 * The stream is skipped forward rather than copied: the descriptor from MediaStore points straight
 * at the original file, so a seek to the middle is an lseek, not a re-read, and a 40 MB FLAC costs
 * no memory beyond the buffer Chromium reads through.
 */
public final class DeviceAudioHandler {

    private static final String TAG = "FoliaShell";

    private static final String PATH_LIST = "/api/device-audio";
    private static final String PATH_STREAM = "/api/device-audio/stream";
    private static final String PATH_COVER = "/api/device-audio/cover";

    private static final int BUFFER_SIZE = 64 * 1024;

    private DeviceAudioHandler() {
    }

    /**
     * Answers a request aimed at one of this handler's routes, or returns null so the caller can
     * fall through to the asset loader. Paths are matched exactly: a prefix test would let
     * `/api/device-audio/anything` reach the stream branch.
     */
    public static WebResourceResponse handle(Context context, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null) {
            return null;
        }
        String path = uri.getPath();
        if (path == null) {
            return null;
        }
        boolean ours = PATH_LIST.equals(path) || PATH_STREAM.equals(path) || PATH_COVER.equals(path);
        if (!ours) {
            return null;
        }

        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return jsonError(405, "Only GET is served");
        }

        if (!DeviceAudioLibrary.hasPermission(context)) {
            // 403 rather than an empty list: the page has to be able to tell "you have not granted
            // access yet" (ask the user) from "you have no music" (say so and stop asking).
            return jsonError(403, "permission-denied");
        }

        if (PATH_LIST.equals(path)) {
            return json(context, DeviceAudioLibrary.describe(context).toString());
        }
        if (PATH_COVER.equals(path)) {
            return cover(context, uri);
        }
        return stream(context, uri, request);
    }

    // ---- list ---------------------------------------------------------------------------

    private static WebResourceResponse json(Context context, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("application/json", "utf-8", 200, "OK", headers,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    // ---- album art ----------------------------------------------------------------------

    private static WebResourceResponse cover(Context context, Uri uri) {
        long albumId = parseLong(uri.getQueryParameter("albumId"), -1L);
        if (albumId < 0) {
            return jsonError(400, "Missing or malformed albumId");
        }
        byte[] art = DeviceAudioLibrary.albumArt(context, albumId);
        if (art == null || art.length == 0) {
            // "No art" is the common case, not a failure: the page shows its own placeholder.
            return jsonError(404, "no-art");
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "public, max-age=86400");
        headers.put("Content-Length", String.valueOf(art.length));
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("image/jpeg", null, 200, "OK", headers,
                new ByteArrayInputStream(art));
    }

    // ---- audio, with Range --------------------------------------------------------------

    private static WebResourceResponse stream(Context context, Uri uri, WebResourceRequest request) {
        long id = parseLong(uri.getQueryParameter("id"), -1L);
        if (id < 0) {
            return jsonError(400, "Missing or malformed id");
        }

        ContentResolver resolver = context.getContentResolver();
        AssetFileDescriptor descriptor = null;
        try {
            descriptor = resolver.openAssetFileDescriptor(DeviceAudioLibrary.trackUri(id), "r");
        } catch (Exception missing) {
            Log.w(TAG, "Device audio " + id + " could not be opened: " + missing);
            return jsonError(404, "track-unreadable");
        }
        if (descriptor == null) {
            return jsonError(404, "track-missing");
        }

        long startOffset = descriptor.getStartOffset();
        long declaredLength = descriptor.getLength();
        if (declaredLength < 0) {
            declaredLength = DeviceAudioLibrary.sizeOf(context, id);
        }

        String mimeType = DeviceAudioLibrary.mimeTypeOf(context, id);
        String rangeHeader = headerOf(request, "range");

        // Without a known length there is nothing to range over: the 200 path still plays, it just
        // cannot be seeked, which is strictly better than refusing to serve the track.
        if (declaredLength <= 0 || rangeHeader == null || rangeHeader.isEmpty()) {
            return fullStream(descriptor, declaredLength, mimeType, startOffset);
        }

        long[] range = parseRange(rangeHeader, declaredLength);
        if (range == null) {
            // Malformed Range is ignored per RFC 9110, and falls back to the whole entity.
            return fullStream(descriptor, declaredLength, mimeType, startOffset);
        }
        if (range[0] < 0) {
            closeQuietly(descriptor);
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Range", "bytes */" + declaredLength);
            headers.put("Accept-Ranges", "bytes");
            headers.put("Content-Length", "0");
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse("text/plain", null, 416,
                    "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
        }

        long rangeStart = range[0];
        long rangeEnd = range[1];
        long rangeLength = rangeEnd - rangeStart + 1;

        InputStream body;
        try {
            body = openAt(descriptor, startOffset, rangeStart, rangeLength);
        } catch (Exception unreadable) {
            Log.w(TAG, "Device audio " + id + " range " + rangeStart + " failed: " + unreadable);
            closeQuietly(descriptor);
            return jsonError(500, "track-unreadable");
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", mimeType);
        headers.put("Content-Length", String.valueOf(rangeLength));
        headers.put("Content-Range", "bytes " + rangeStart + "-" + rangeEnd + "/" + declaredLength);
        headers.put("Accept-Ranges", "bytes");
        // The device library is the user's own file system: it can change at any moment, and a
        // cached byte range from before an edit would be served as if it were still current.
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        return new WebResourceResponse(mimeType, null, 206, "Partial Content", headers, body);
    }

    private static WebResourceResponse fullStream(AssetFileDescriptor descriptor, long length,
                                                  String mimeType, long startOffset) {
        InputStream body;
        try {
            body = openAt(descriptor, startOffset, 0L, length > 0 ? length : -1L);
        } catch (Exception unreadable) {
            Log.w(TAG, "Device audio full stream failed: " + unreadable);
            closeQuietly(descriptor);
            return jsonError(500, "track-unreadable");
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", mimeType);
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        if (length > 0) {
            headers.put("Content-Length", String.valueOf(length));
            // Only advertised when the length is real, because a Range answer needs a total to
            // build Content-Range from; promising it without one makes the player ask and fail.
            headers.put("Accept-Ranges", "bytes");
        }
        return new WebResourceResponse(mimeType, null, 200, "OK", headers, body);
    }

    /**
     * A stream positioned at `rangeStart` bytes into the item and bounded to `rangeLength` (or to the
     * end of the item when negative).
     *
     * assetFileDescriptor.createInputStream() already starts at the descriptor's own start offset and
     * stops at its length, so only the range start has to be consumed. Skipping rather than reading
     * matters: FileInputStream.skip is an lseek on a real descriptor, so a seek to the middle of a
     * 40 MB file costs nothing, while a pipe-backed descriptor degrades to a bounded read-only loop
     * that is still correct, just slower.
     */
    private static InputStream openAt(AssetFileDescriptor descriptor, long startOffset,
                                      long rangeStart, long rangeLength) throws IOException {
        InputStream raw = descriptor.createInputStream();
        boolean positioned = false;
        try {
            skipFully(raw, rangeStart);
            positioned = true;
            return new BoundedStream(raw, descriptor, rangeLength);
        } finally {
            if (!positioned) {
                closeQuietly(raw);
            }
        }
    }

    private static void skipFully(InputStream stream, long bytes) throws IOException {
        long remaining = bytes;
        while (remaining > 0) {
            long skipped = stream.skip(remaining);
            if (skipped <= 0) {
                // skip() is allowed to report 0 without being at EOF; read one byte to make progress.
                if (stream.read() < 0) {
                    throw new IOException("Range start is past the end of the item");
                }
                remaining--;
                continue;
            }
            remaining -= skipped;
        }
    }

    /** An InputStream that hands out at most `limit` bytes and closes the descriptor with itself. */
    private static final class BoundedStream extends InputStream {

        private final InputStream delegate;
        private final AssetFileDescriptor descriptor;
        private long remaining;

        BoundedStream(InputStream delegate, AssetFileDescriptor descriptor, long limit) {
            this.delegate = delegate;
            this.descriptor = descriptor;
            this.remaining = limit < 0 ? Long.MAX_VALUE : limit;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) {
                return -1;
            }
            int value = delegate.read();
            if (value >= 0) {
                remaining--;
            }
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0) {
                return -1;
            }
            int allowed = (int) Math.min(length, remaining);
            int read = delegate.read(buffer, offset, allowed);
            if (read > 0) {
                remaining -= read;
            }
            return read;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(delegate.available(), Math.max(remaining, 0));
        }

        @Override
        public void close() throws IOException {
            try {
                delegate.close();
            } finally {
                closeQuietly(descriptor);
            }
        }
    }

    // ---- helpers ------------------------------------------------------------------------

    /**
     * Parses a single-range `bytes=` header into {start, end} inclusive, {-1, -1} when the range is
     * unsatisfiable, or null when it is malformed and should be ignored.
     */
    private static long[] parseRange(String header, long length) {
        String value = header.trim().toLowerCase(Locale.US);
        if (!value.startsWith("bytes=")) {
            return null;
        }
        value = value.substring("bytes=".length()).trim();
        // Multi-range answers need multipart/byteranges, which a media element never asks for.
        if (value.contains(",")) {
            return null;
        }
        int dash = value.indexOf('-');
        if (dash < 0) {
            return null;
        }
        String startText = value.substring(0, dash).trim();
        String endText = value.substring(dash + 1).trim();
        try {
            if (startText.isEmpty()) {
                // "bytes=-N" is the last N bytes, not a range starting at zero.
                if (endText.isEmpty()) {
                    return null;
                }
                long suffix = Long.parseLong(endText);
                if (suffix <= 0) {
                    return new long[]{ -1L, -1L };
                }
                long start = Math.max(0L, length - suffix);
                return new long[]{ start, length - 1 };
            }
            long start = Long.parseLong(startText);
            if (start >= length) {
                return new long[]{ -1L, -1L };
            }
            long end = endText.isEmpty() ? length - 1 : Long.parseLong(endText);
            if (end < start) {
                return new long[]{ -1L, -1L };
            }
            return new long[]{ start, Math.min(end, length - 1) };
        } catch (NumberFormatException malformed) {
            return null;
        }
    }

    private static String headerOf(WebResourceRequest request, String name) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) {
            return null;
        }
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (header.getKey() != null && header.getKey().equalsIgnoreCase(name)) {
                return header.getValue();
            }
        }
        return null;
    }

    private static long parseLong(String value, long fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException malformed) {
            return fallback;
        }
    }

    private static void closeQuietly(AssetFileDescriptor descriptor) {
        if (descriptor == null) {
            return;
        }
        try {
            descriptor.close();
        } catch (Exception ignored) {
            // Already closed by the stream, or the provider refused; nothing to recover.
        }
    }

    private static void closeQuietly(InputStream stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (Exception ignored) {
            // Same as above.
        }
    }

    static WebResourceResponse jsonError(int status, String message) {
        String body = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("application/json", "utf-8", status, reasonOf(status), headers,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static String reasonOf(int status) {
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 416: return "Range Not Satisfiable";
            case 500: return "Internal Server Error";
            default: return status >= 200 && status < 300 ? "OK" : "Error";
        }
    }
}
