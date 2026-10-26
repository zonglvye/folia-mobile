package app.folia.mobile;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves `/api/media-proxy?token=…` out of {@link MediaCache}.
 *
 * This is the same-origin half of the audio relay: the page asks for bytes it can address, the shell
 * answers from a track it already holds in memory. Two ways in, both intentional:
 *   - `?token=&from=&to=` — what the page uses for MSE, one chunk at a time.
 *   - a plain `Range: bytes=…` header — kept because a media element pointed here directly still
 *     asks that way. Android answers 206 correctly, unlike the HarmonyOS interceptor, so both work.
 *
 * Slices are clamped to what has arrived, never padded: the page treats a short body as "ask again
 * later", while a padded one would corrupt the stream it is appending.
 */
public final class MediaProxyHandler {

    /** Kept identical to the path in the web layer (`shellOnlineAudio.ts`). */
    public static final String PATH = "/api/media-proxy";

    private MediaProxyHandler() {
    }

    public static WebResourceResponse handle(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !PATH.equals(uri.getPath())) {
            return null;
        }
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return error(405, "Only GET is served");
        }

        int token = parseInt(uri.getQueryParameter("token"), -1);
        if (token < 0) {
            return error(400, "Missing or malformed token");
        }

        MediaCache.Snapshot snapshot = MediaCache.snapshot(token);
        if (snapshot == null) {
            return error(404, "unknown token");
        }
        if (snapshot.received <= 0L) {
            // Not an error the page should retry in a tight loop: it polls mediaProgress first and
            // only asks once bytes exist.
            return error(404, "media not ready");
        }

        String fromParam = uri.getQueryParameter("from");
        String toParam = uri.getQueryParameter("to");
        if (fromParam != null && toParam != null) {
            long from = parseLong(fromParam, 0L);
            long to = parseLong(toParam, snapshot.received - 1L);
            return slice(token, snapshot, Math.max(0L, from), to, 200, null);
        }

        long[] range = parseRange(headerOf(request, "range"), snapshot.received);
        if (range != null && range[0] < 0L) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Range", "bytes */" + snapshot.received);
            headers.put("Accept-Ranges", "bytes");
            headers.put("Content-Length", "0");
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse("text/plain", null, 416, "Range Not Satisfiable",
                    headers, new ByteArrayInputStream(new byte[0]));
        }
        if (range != null) {
            return slice(token, snapshot, range[0], range[1], 206, range);
        }
        return slice(token, snapshot, 0L, snapshot.received - 1L, 200, null);
    }

    private static WebResourceResponse slice(int token, MediaCache.Snapshot snapshot, long from,
                                            long to, int status, long[] range) {
        byte[] body = MediaCache.slice(token, from, to);
        if (body == null || body.length == 0) {
            return error(404, "media not ready");
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", snapshot.mime);
        // Without an explicit length Chromium buffers the whole body before it can play, which is
        // exactly the latency this path exists to remove.
        headers.put("Content-Length", String.valueOf(body.length));
        headers.put("Accept-Ranges", "bytes");
        if (status == 206 && range != null) {
            headers.put("Content-Range",
                    "bytes " + range[0] + "-" + (range[0] + body.length - 1) + "/" + snapshot.received);
        }
        // The bytes behind a token are still arriving; a cached copy would freeze a half track.
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        // encoding must stay null: a charset on a binary body makes the WebView treat it as text and
        // stop at the first invalid sequence.
        return new WebResourceResponse(snapshot.mime, null, status,
                status == 206 ? "Partial Content" : "OK", headers, new ByteArrayInputStream(body));
    }

    /**
     * Parses a single-range `bytes=` header into {start, end} inclusive, {-1, -1} when the range is
     * unsatisfiable, or null when it is malformed and should be ignored (RFC 9110: fall back to the
     * whole entity).
     */
    private static long[] parseRange(String header, long length) {
        if (header == null || header.isEmpty()) {
            return null;
        }
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
                if (suffix <= 0L) {
                    return new long[]{ -1L, -1L };
                }
                return new long[]{ Math.max(0L, length - suffix), length - 1L };
            }
            long start = Long.parseLong(startText);
            if (start >= length) {
                return new long[]{ -1L, -1L };
            }
            long end = endText.isEmpty() ? length - 1L : Long.parseLong(endText);
            if (end < start) {
                return new long[]{ -1L, -1L };
            }
            return new long[]{ start, Math.min(end, length - 1L) };
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

    private static int parseInt(String value, int fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException malformed) {
            return fallback;
        }
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

    private static WebResourceResponse error(int status, String message) {
        String body = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("application/json", "utf-8", status, reasonOf(status),
                headers, new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static String reasonOf(int status) {
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 416: return "Range Not Satisfiable";
            default: return status >= 200 && status < 300 ? "OK" : "Error";
        }
    }
}
