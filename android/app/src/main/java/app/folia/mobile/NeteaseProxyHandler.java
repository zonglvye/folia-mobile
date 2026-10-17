package app.folia.mobile;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Serves the web app's `/api/netease-proxy` endpoint from inside the shell.
 *
 * Why this exists: the web build talks to a NetEase API instance over plain JSON, and that instance
 * is the component that runs the eapi/weapi encryption and the cookie handling. There is no such
 * instance next to the app on a phone, and the NetEase hosts send no CORS headers, so the page
 * cannot call them itself. This class is the one hole punched through for it: a dumb, allowlisted
 * transport. All encryption, route mapping and cookie bookkeeping stay in the web layer
 * (`services/onlineMusic/neteaseLocalApi.ts`), so the provider logic never ends up in the shell -
 * and the same web code keeps running unchanged against a real instance on the desktop build.
 *
 * Two details are forced by the platform rather than chosen:
 *   - The page can only issue GET here. `WebResourceRequest` exposes no request body at all, so a
 *     POST from the page could not be forwarded faithfully. The page therefore puts the upstream
 *     method and form body in the query string and this class replays them as a real POST.
 *   - The answer is a JSON envelope, not the upstream body verbatim, because the caller also needs
 *     the `Set-Cookie` values: the NetEase session cookie arrives only in headers, and a response
 *     header written through {@link WebResourceResponse} is not something the page is guaranteed to
 *     see. The body always arrives, so the cookies ride inside it.
 *
 * Shape of the answer, always HTTP 200 `application/json`:
 *   {"status": 200, "cookie": "MUSIC_U=...; NMTID=...", "body": "<upstream body, as text>"}
 * The real status lives in `status` rather than in the page-visible HTTP status, so the web layer
 * has exactly one failure channel to read instead of two. `cookie` is empty when the upstream set
 * none. Attribute flags (Path/Domain/Expires/HttpOnly) are stripped: the page keeps its own jar and
 * only ever wants `name=value`.
 */
public final class NeteaseProxyHandler {

    private static final String TAG = "FoliaShell";

    /** Path the web app calls. */
    public static final String PATH = "/api/netease-proxy";

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    /** Lyric documents are the largest thing proxied here (a few hundred KB); this is a backstop. */
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;

    /** A form-encoded eapi/weapi payload is a couple of KB; anything huge is a bug, not a request. */
    private static final int MAX_REQUEST_BODY_CHARS = 512 * 1024;

    private static final String DEFAULT_USER_AGENT =
            "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";

    private static final Pattern CHARSET = Pattern.compile("charset=([^;]+)", Pattern.CASE_INSENSITIVE);

    private NeteaseProxyHandler() {
    }

    /**
     * Handles a page request for the proxy path. Returns null when the request is not one this
     * handler owns, so the caller can fall through to another handler.
     */
    public static WebResourceResponse handle(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !PATH.equals(uri.getPath())) {
            return null;
        }

        // A POST from the page could not be forwarded: the body is not readable here. Saying so is
        // better than silently replaying an empty body upstream and reporting the 400 that follows.
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return envelope(501, "", "{\"code\":501,\"msg\":\"Only GET reaches the NetEase proxy\"}");
        }

        String target = uri.getQueryParameter("url");
        if (target == null || target.isEmpty()) {
            return envelope(400, "", "{\"code\":400,\"msg\":\"Missing url parameter\"}");
        }

        URL targetUrl;
        try {
            targetUrl = new URL(target);
        } catch (Exception malformed) {
            return envelope(400, "", "{\"code\":400,\"msg\":\"Malformed url parameter\"}");
        }

        // The proxy only exists so the page can reach NetEase. Restricting it to https on the
        // NetEase hosts keeps it from becoming an open relay for anything else.
        String scheme = targetUrl.getProtocol() == null ? "" : targetUrl.getProtocol().toLowerCase(Locale.US);
        if (!"https".equals(scheme)) {
            return envelope(403, "", "{\"code\":403,\"msg\":\"Forbidden: https only\"}");
        }
        String host = targetUrl.getHost() == null ? "" : targetUrl.getHost().toLowerCase(Locale.US);
        if (!isAllowedHost(host)) {
            return envelope(403, "", "{\"code\":403,\"msg\":\"Forbidden: domain not allowed\"}");
        }

        String method = uri.getQueryParameter("method");
        if (method == null || method.isEmpty()) {
            method = "POST";
        }
        if (!"POST".equalsIgnoreCase(method) && !"GET".equalsIgnoreCase(method)) {
            return envelope(400, "", "{\"code\":400,\"msg\":\"Unsupported method\"}");
        }

        String formBody = uri.getQueryParameter("body");
        if (formBody != null && formBody.length() > MAX_REQUEST_BODY_CHARS) {
            return envelope(413, "", "{\"code\":413,\"msg\":\"Request body too large\"}");
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) targetUrl.openConnection();
            connection.setRequestMethod(method.toUpperCase(Locale.US));
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            // HttpURLConnection does not decompress, so asking for gzip would hand the page bytes
            // it cannot read.
            connection.setRequestProperty("Accept-Encoding", "identity");

            String cookie = uri.getQueryParameter("cookie");
            if (cookie != null && !cookie.isEmpty()) {
                connection.setRequestProperty("Cookie", cookie);
            }
            String referer = uri.getQueryParameter("referer");
            if (referer != null && !referer.isEmpty()) {
                connection.setRequestProperty("Referer", referer);
            }
            String userAgent = uri.getQueryParameter("ua");
            connection.setRequestProperty("User-Agent",
                    userAgent == null || userAgent.isEmpty() ? DEFAULT_USER_AGENT : userAgent);

            if (formBody != null && !formBody.isEmpty()) {
                byte[] payload = formBody.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type",
                        "application/x-www-form-urlencoded;charset=utf-8");
                connection.setFixedLengthStreamingMode(payload.length);
                // Closing the stream is what actually sends the request.
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }
            }

            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            byte[] raw = readBody(connection, status);
            String text = new String(raw, charsetOf(contentType));

            return envelope(status, collectCookies(connection), text);
        } catch (Exception error) {
            Log.w(TAG, "NetEase proxy failed for " + target + ": " + error);
            // 502 is what the web layer already treats as an upstream network failure, so the page's
            // existing diagnostics read this correctly.
            return envelope(502, "", "{\"code\":502,\"msg\":"
                    + JSONObject.quote(String.valueOf(error)) + "}");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** `music.163.com` and its `interface*` siblings; nothing else is reachable through here. */
    private static boolean isAllowedHost(String host) {
        return host.equals("music.163.com") || host.endsWith(".music.163.com");
    }

    /**
     * Flattens every `Set-Cookie` value to `name=value` and joins them with `; `.
     *
     * A deletion (an empty value, or `Max-Age=0` / a past `Expires`) is kept as `name=` so the
     * page's jar can drop the entry: emitting nothing at all would leave the old cookie in place
     * and a logout would not stick.
     */
    private static String collectCookies(HttpURLConnection connection) {
        StringBuilder joined = new StringBuilder();
        try {
            for (Map.Entry<String, List<String>> field : connection.getHeaderFields().entrySet()) {
                if (field.getKey() == null || !"set-cookie".equalsIgnoreCase(field.getKey())) {
                    continue;
                }
                for (String raw : field.getValue()) {
                    String pair = cookiePair(raw);
                    if (pair == null || pair.isEmpty()) {
                        continue;
                    }
                    if (joined.length() > 0) {
                        joined.append("; ");
                    }
                    joined.append(pair);
                }
            }
        } catch (Exception unreadable) {
            Log.w(TAG, "Could not read Set-Cookie headers: " + unreadable);
        }
        return joined.toString();
    }

    /** `MUSIC_U=abc; Path=/; HttpOnly` becomes `MUSIC_U=abc`, empty when it is a deletion. */
    private static String cookiePair(String setCookie) {
        if (setCookie == null) {
            return null;
        }
        int semicolon = setCookie.indexOf(';');
        String pair = (semicolon >= 0 ? setCookie.substring(0, semicolon) : setCookie).trim();
        int equals = pair.indexOf('=');
        if (equals <= 0) {
            return null;
        }
        String name = pair.substring(0, equals).trim();
        String value = pair.substring(equals + 1).trim();
        if (name.isEmpty()) {
            return null;
        }
        return value.isEmpty() ? name + "=" : pair;
    }

    /** Reads the whole response, using the error stream for non-2xx answers. */
    private static byte[] readBody(HttpURLConnection connection, int status) throws IOException {
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) {
            return new byte[0];
        }
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) > 0) {
                total += read;
                if (total > MAX_BODY_BYTES) {
                    throw new IOException("Response exceeds " + MAX_BODY_BYTES + " bytes");
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static Charset charsetOf(String contentType) {
        if (contentType != null) {
            Matcher matcher = CHARSET.matcher(contentType);
            if (matcher.find()) {
                String charset = matcher.group(1).trim();
                if (charset.startsWith("\"") && charset.endsWith("\"") && charset.length() > 1) {
                    charset = charset.substring(1, charset.length() - 1);
                }
                try {
                    return Charset.forName(charset);
                } catch (Exception unsupported) {
                    // NetEase answers in UTF-8; an unrecognised label is not worth a failure.
                }
            }
        }
        return StandardCharsets.UTF_8;
    }

    /** Builds the envelope described in the class comment. */
    private static WebResourceResponse envelope(int status, String cookie, String body) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("status", status);
            payload.put("cookie", cookie == null ? "" : cookie);
            payload.put("body", body == null ? "" : body);
        } catch (Exception impossible) {
            // put() on a JSONObject cannot fail for these types; keep the compiler happy.
        }
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        // Never cached: every one of these carries a live session cookie.
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "utf-8", 200, "OK", headers,
                new ByteArrayInputStream(bytes));
    }
}
