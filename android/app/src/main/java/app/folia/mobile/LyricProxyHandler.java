package app.folia.mobile;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Serves the web app's `/api/lyric-proxy` endpoint from inside the shell.
 *
 * Why this exists: the web build routes several online lookups through a same-origin
 * `/api/lyric-proxy?url=...` helper, because a browser cannot call those hosts directly — the
 * responses carry no CORS headers. On a deployed web build that helper is a serverless function
 * (`api-ts/lyric-proxy.ts`, which is in this repo and is the contract this class implements).
 * Inside the shell there is no server, so the shell answers it instead, using a native HTTP
 * client. Because the page only ever talks to its own origin, no CORS or mixed-content rule is
 * involved at all — and the upstream request may even be plain http, which the page could never
 * make itself.
 *
 * What becomes reachable through it, all measured against the live endpoints:
 *   - KuGou anonymous signed search (the signature is computed in the web layer already)
 *   - KuGou and QQ lyric lookups
 *   - Online cover images (`services/coverCache.ts`)
 *
 * This class deliberately mirrors the TypeScript contract rather than inventing one: same host
 * allowlist, same ignored request headers, same `u.y.qq.com` special case, same pass-through of
 * status and content type.
 */
public final class LyricProxyHandler {

    private static final String TAG = "FoliaShell";

    /** Path the web app calls. Kept identical to the deployed serverless function's route. */
    public static final String PATH = "/api/lyric-proxy";

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    /** Search pages and lyric documents are small; this only guards against a runaway response. */
    private static final int MAX_BODY_BYTES = 8 * 1024 * 1024;

    /**
     * Request headers that must not be forwarded upstream. Mirrors the TypeScript list, with one
     * addition: `accept-encoding` is dropped because {@link HttpURLConnection} does not
     * decompress, so asking for gzip would hand the page compressed bytes.
     */
    private static final String[] IGNORED_FORWARD_HEADERS = {
            "host", "connection", "content-length", "origin", "referer", "cookie",
            "authorization", "proxy-authorization", "x-vercel-protection-bypass",
            "accept-encoding",
    };

    private static final Pattern CHARSET = Pattern.compile("charset=([^;]+)", Pattern.CASE_INSENSITIVE);

    private LyricProxyHandler() {
    }

    /**
     * Handles a page request for the proxy path. Returns null when the request is not one this
     * handler owns, so the caller can fall through to another handler.
     */
    public static WebResourceResponse handle(WebResourceRequest request) {
        Uri uri = request.getUrl();
        // Exact path match: the deployed route is `/api/lyric-proxy`, and a prefix test would
        // also swallow unrelated paths that merely start with it.
        if (uri == null || !PATH.equals(uri.getPath())) {
            return null;
        }

        // WebViewResourceRequest exposes no request body, so a write could not be forwarded
        // faithfully. Every caller in this app uses GET; say so rather than sending an empty body.
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return jsonError(501, "Only GET is proxied");
        }

        String target = uri.getQueryParameter("url");
        if (target == null || target.isEmpty()) {
            return jsonError(400, "Missing url parameter");
        }

        URL targetUrl;
        try {
            targetUrl = new URL(target);
        } catch (Exception malformed) {
            return jsonError(400, "Malformed url parameter");
        }

        // Only http(s), and only the hosts the deployed function allows. This is the one place
        // that stops the page from turning the shell into an open relay.
        String scheme = targetUrl.getProtocol() == null ? "" : targetUrl.getProtocol().toLowerCase(Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return jsonError(403, "Forbidden: unsupported scheme");
        }
        String host = targetUrl.getHost() == null ? "" : targetUrl.getHost().toLowerCase(Locale.US);
        if (!isAllowedHost(host)) {
            return jsonError(403, "Forbidden: Domain not allowed");
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) targetUrl.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept-Encoding", "identity");

            Map<String, String> forwarded = filterHeaders(request.getRequestHeaders());
            for (Map.Entry<String, String> header : forwarded.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }

            // Tencent's lyric host only answers when it is treated as a logged-out mobile client.
            if ("u.y.qq.com".equals(host)) {
                connection.setRequestProperty("Cookie", "tmeLoginType=-1;");
                connection.setRequestProperty("User-Agent", "okhttp/3.14.9");
            }

            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            byte[] body = readBody(connection, status);

            // Deliberately no Cache-Control of our own. The deployed function sets none either, and
            // the callers make caching safe: search URLs carry a fresh signature and client time, so
            // they are unique per request, while lyrics and covers are the responses that benefit
            // from being cached at all.
            Map<String, String> responseHeaders = new HashMap<>();

            return new WebResourceResponse(
                    mimeTypeOf(contentType),
                    charsetOf(contentType),
                    status,
                    reasonOf(status),
                    responseHeaders,
                    new ByteArrayInputStream(body));
        } catch (Exception error) {
            Log.w(TAG, "Lyric proxy failed for " + target + ": " + error);
            return jsonError(502, "Proxy request failed");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static boolean isAllowedHost(String host) {
        return host.equals("qq.com") || host.endsWith(".qq.com")
                || host.equals("y.gtimg.cn")
                || host.equals("kugou.com") || host.endsWith(".kugou.com");
    }

    private static Map<String, String> filterHeaders(Map<String, String> requestHeaders) {
        Map<String, String> forwarded = new LinkedHashMap<>();
        if (requestHeaders == null) {
            return forwarded;
        }
        for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
            if (header.getKey() == null || header.getValue() == null) {
                continue;
            }
            String name = header.getKey().toLowerCase(Locale.US);
            boolean ignored = false;
            for (String candidate : IGNORED_FORWARD_HEADERS) {
                if (candidate.equals(name)) {
                    ignored = true;
                    break;
                }
            }
            if (!ignored) {
                forwarded.put(header.getKey(), header.getValue());
            }
        }
        return forwarded;
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

    private static String mimeTypeOf(String contentType) {
        if (contentType == null || contentType.isEmpty()) {
            return "application/octet-stream";
        }
        int semicolon = contentType.indexOf(';');
        String mime = (semicolon >= 0 ? contentType.substring(0, semicolon) : contentType).trim();
        return mime.isEmpty() ? "application/octet-stream" : mime;
    }

    private static String charsetOf(String contentType) {
        if (contentType == null) {
            return null;
        }
        Matcher matcher = CHARSET.matcher(contentType);
        if (!matcher.find()) {
            return null;
        }
        String charset = matcher.group(1).trim();
        if (charset.startsWith("\"") && charset.endsWith("\"") && charset.length() > 1) {
            charset = charset.substring(1, charset.length() - 1);
        }
        return charset.isEmpty() ? null : charset;
    }

    private static String reasonOf(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 504: return "Gateway Timeout";
            default: return status >= 200 && status < 300 ? "OK" : "Error";
        }
    }

    /** JSON error in the same shape the deployed function returns, so the page's handling matches. */
    private static WebResourceResponse jsonError(int status, String message) {
        byte[] body = ("{\"error\":\"" + message.replace("\"", "'") + "\"}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "utf-8", status,
                reasonOf(status), headers, new ByteArrayInputStream(body));
    }
}
