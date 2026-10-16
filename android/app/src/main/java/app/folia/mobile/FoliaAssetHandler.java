package app.folia.mobile;

import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the bundled web build out of the APK's assets as if it were a website root.
 *
 * This is the piece that decides whether offline is structural or best-effort. The assets sit
 * inside the APK, so they are always present; and because WebViewAssetLoader answers requests
 * for an https:// origin, the WebView still treats the page as a secure context, which is what
 * keeps IndexedDB, OPFS and Cache Storage available to the web app. Loading the same files over
 * file:// would silently take all three away.
 *
 * URL layout: the virtual site root maps to the asset directory, so Vite's absolute
 * "/assets/index-<hash>.js" URLs resolve correctly with no rewriting and no custom `base`.
 */
public final class FoliaAssetHandler implements WebViewAssetLoader.PathHandler {

    /** Directory inside app/src/main/assets that holds the built web app. */
    private static final String ASSET_ROOT = "www";

    /** Served for extensionless paths so client-side routes never land on a blank screen. */
    private static final String SPA_FALLBACK = "index.html";

    /**
     * Filenames whose URL survives app updates, so they must never be served from cache.
     * Everything else under /assets/ is content-hashed and can be cached indefinitely.
     */
    private static final String[] MUST_REVALIDATE = {
            "index.html", "sw.js", "manifest.webmanifest", "runtime-config.js",
    };

    private final AssetManager assets;

    public FoliaAssetHandler(AssetManager assets) {
        this.assets = assets;
    }

    @Override
    public WebResourceResponse handle(String path) {
        String relative = normalize(path);
        if (relative == null) {
            return null;
        }
        WebResourceResponse response = open(relative);
        if (response == null && !relative.contains(".") && !isApiPath(relative)) {
            response = open(SPA_FALLBACK);
        }
        return response;
    }

    /**
     * `/api/*` must never fall back to the SPA shell. Those paths are answered by the proxy or by a
     * gateway, and handing the caller an HTML document instead of an error turns a clear "endpoint
     * unavailable" into an opaque JSON parse failure on the page.
     */
    private static boolean isApiPath(String relative) {
        return relative.equals("api") || relative.startsWith("api/");
    }

    /** Strips the leading slash and rejects anything that could escape the asset root. */
    private static String normalize(String path) {
        if (path == null) {
            return null;
        }
        String relative = path.startsWith("/") ? path.substring(1) : path;
        if (relative.isEmpty()) {
            return SPA_FALLBACK;
        }
        if (relative.contains("..") || relative.startsWith("/")) {
            return null;
        }
        return relative;
    }

    private WebResourceResponse open(String relative) {
        String assetPath = ASSET_ROOT + "/" + relative;
        try {
            InputStream stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
            return new WebResourceResponse(
                    mimeTypeFor(relative),
                    null,
                    200,
                    "OK",
                    headersFor(relative),
                    stream);
        } catch (IOException notAnAsset) {
            // Returning null hands the request back to the WebView, which will try the network
            // and fail. That is the correct outcome: nothing outside the APK is loadable here.
            return null;
        }
    }

    private static Map<String, String> headersFor(String relative) {
        Map<String, String> headers = new HashMap<>();
        String name = relative.substring(relative.lastIndexOf('/') + 1).toLowerCase(Locale.US);
        boolean revalidate = false;
        for (String candidate : MUST_REVALIDATE) {
            if (candidate.equals(name)) {
                revalidate = true;
                break;
            }
        }
        if (revalidate) {
            headers.put("Cache-Control", "no-store");
        } else {
            headers.put("Cache-Control", "public, max-age=31536000, immutable");
        }
        return headers;
    }

    /**
     * Explicit MIME table. `text/javascript` in particular is not optional: a module script
     * served with the wrong content type is refused by the browser and the whole app fails to
     * boot, which is the classic symptom of a hand-rolled asset server.
     */
    private static String mimeTypeFor(String relative) {
        String name = relative.toLowerCase(Locale.US);
        int dot = name.lastIndexOf('.');
        String extension = dot >= 0 ? name.substring(dot + 1) : "";
        switch (extension) {
            case "js":
            case "mjs":
                return "text/javascript";
            case "css":
                return "text/css";
            case "html":
                return "text/html";
            case "json":
            case "map":
            case "webmanifest":
                return "application/json";
            case "wasm":
                return "application/wasm";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "webp":
                return "image/webp";
            case "avif":
                return "image/avif";
            case "gif":
                return "image/gif";
            case "ico":
                return "image/x-icon";
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "ttf":
                return "font/ttf";
            case "otf":
                return "font/otf";
            case "mp3":
                return "audio/mpeg";
            case "flac":
                return "audio/flac";
            case "m4a":
                return "audio/mp4";
            case "ogg":
            case "opus":
                return "audio/ogg";
            case "wav":
                return "audio/wav";
            case "txt":
                return "text/plain";
            case "xml":
                return "application/xml";
            default:
                return "application/octet-stream";
        }
    }
}
