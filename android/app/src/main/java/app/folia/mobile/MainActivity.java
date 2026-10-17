package app.folia.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

/**
 * The whole shell: one fullscreen WebView showing the bundled Folia build, plus the pieces a
 * browser cannot provide on Android (immersive fullscreen, a file chooser that survives
 * multi-select, and a landscape guarantee).
 *
 * Design notes worth keeping:
 * - The WebView is never recreated on rotation. The activity declares every relevant
 *   configChange, because recreating it would destroy the WebView and stop playback.
 * - Back never finishes the activity while a page is loaded: it walks history and then moves
 *   the task to the background, so audio keeps playing.
 */
public class MainActivity extends Activity {

    private static final String TAG = "FoliaShell";

    /** Virtual origin the bundled assets are served from. Changing it changes the app origin. */
    private static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    private static final String HOME_URL = "https://" + VIRTUAL_HOST + "/index.html";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_NOTIFICATION = 1002;
    private static final int REQ_AUDIO_PERMISSION = 1003;
    private static final String STATE_IMMERSIVE = "immersive";

    private FrameLayout rootLayout;
    private WebView webView;
    private View portraitHint;
    private WebViewAssetLoader assetLoader;
    private FoliaChromeClient chromeClient;
    private ValueCallback<Uri[]> fileChooserCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    /** Immersive is the default: this is a fullscreen viewing player, not a utility app. */
    private boolean immersiveEnabled = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Order matters: the service worker client has to be installed before any WebView exists,
        // otherwise a worker that is already running for the origin keeps handling its own requests
        // through a client that was never set. Everything it needs (assetLoader) is read at request
        // time, so it is fine for that field to be assigned a few lines later.
        installServiceWorkerClient();

        rootLayout = new FrameLayout(this);
        webView = new WebView(this);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        portraitHint = buildPortraitHint();
        rootLayout.addView(portraitHint, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(VIRTUAL_HOST)
                // Only the https origin is served; the http variant would be a downgrade path
                // to the same content for no benefit.
                .setHttpAllowed(false)
                .addPathHandler("/", new FoliaAssetHandler(getAssets()))
                .build();

        setupWebView();

        // Native transport controls (notification / lock screen / headset unplug / voice search)
        // are routed back into the page as a DOM event, the same way the page already listens
        // for media-session commands in the desktop build.
        PlaybackService.setCommandSink(payload -> runOnUiThread(() -> {
            if (webView == null) {
                return;
            }
            webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('folia-android-media-command',{detail:"
                            + org.json.JSONObject.quote(payload) + "}));",
                    null);
        }));

        requestNotificationPermissionIfNeeded();

        if (savedInstanceState != null) {
            immersiveEnabled = savedInstanceState.getBoolean(STATE_IMMERSIVE, true);
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME_URL);
        }
        applyImmersiveMode();
        updatePortraitHint();
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // Without DOM storage the app cannot even boot: every persisted store is localStorage
        // or IndexedDB.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Playlist auto-advance, resume-on-launch and the stage's own autoplay all start
        // playback without a user gesture.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // The page is served from assets, never from file://, so file access stays closed.
        settings.setAllowFileAccess(false);
        // Content access must stay open: the system file picker answers with content:// URIs
        // and the WebView reads those to build the File objects the page receives.
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        // A fixed editorial layout cannot survive the system font scale; the app sizes its own
        // type.
        settings.setTextZoom(100);

        webView.setBackgroundColor(0xFF17141F);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        chromeClient = new FoliaChromeClient();
        webView.setWebChromeClient(chromeClient);
        webView.setWebViewClient(new FoliaWebViewClient());
        webView.addJavascriptInterface(new FoliaBridge(this), "foliaAndroid");

        // Cookies matter as soon as online sources are enabled, and the WebView keeps them in
        // memory until flushed.
        CookieManager.getInstance().setAcceptCookie(true);

        if (isDebuggable()) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    // ---- asset serving and navigation -------------------------------------------------

    private final class FoliaWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            WebResourceResponse served = serveRequest(request);
            return served != null ? served : super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url == null) {
                return false;
            }
            if (VIRTUAL_HOST.equals(url.getHost())) {
                return false;
            }
            // Anything not part of the bundled app leaves the shell rather than replacing it,
            // which would strand the user with no way back.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                Toast.makeText(MainActivity.this, url.toString(), Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                // Assets are always present, so a main-frame failure means the bundle is
                // missing or the asset handler refused the path. Log it loudly instead of
                // showing an offline page that would hide a packaging bug.
                Log.e(TAG, "Main frame failed to load: " + error.getDescription()
                        + " url=" + request.getUrl());
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // This app runs heavy WebGL visualisers, so a renderer OOM kill is a real failure
            // mode. Rebuilding the activity is the only way back to a usable WebView.
            Log.e(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + ")");
            rootLayout.removeView(view);
            view.destroy();
            webView = null;
            recreate();
            return true;
        }
    }

    // ---- request interception, shared by the page and by its service worker ------------

    /**
     * Answers a request aimed at the virtual origin, or returns null so it can reach the network.
     *
     * The proxy is consulted before the asset loader because /api/ is not a file in the bundle; a
     * path that matches neither simply fails, which is correct since nothing outside the APK is
     * meant to be loadable from this origin. (A configurable absolute gateway for the other /api
     * paths — theme generation, QQ sign-in — would hook in here, but those need a deployed backend
     * the shell cannot supply on its own.)
     */
    private WebResourceResponse serveRequest(WebResourceRequest request) {
        Uri url = request.getUrl();
        if (url == null || !VIRTUAL_HOST.equals(url.getHost())) {
            return null;
        }
        WebResourceResponse proxyResponse = LyricProxyHandler.handle(request);
        if (proxyResponse != null) {
            return proxyResponse;
        }
        // NetEase needs a second, stricter transport: its API is POST-with-form-body and its
        // session lives in Set-Cookie headers. See NeteaseProxyHandler for why that has to be a
        // native replay instead of an ordinary fetch from the page.
        WebResourceResponse neteaseResponse = NeteaseProxyHandler.handle(request);
        if (neteaseResponse != null) {
            return neteaseResponse;
        }
        // The device's own music library. Tried before the asset loader for the same reason as the
        // proxy: /api/ is not a file in the bundle, and the asset handler's SPA fallback would
        // otherwise answer these paths with an HTML document.
        WebResourceResponse deviceAudioResponse = DeviceAudioHandler.handle(this, request);
        if (deviceAudioResponse != null) {
            return deviceAudioResponse;
        }
        return assetLoader == null ? null : assetLoader.shouldInterceptRequest(url);
    }

    /**
     * The web build registers a service worker, and a service worker's own requests are NOT routed
     * through WebViewClient — they need a ServiceWorkerClient. Without one two things break at once:
     * the page's `/api/lyric-proxy` calls (online search, lyrics, covers) would never reach the
     * shell's proxy, and the worker's own precache fetches could not read the bundled assets.
     * This is required for online sources, not an optimisation.
     */
    private void installServiceWorkerClient() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            Log.w(TAG, "Service worker interception unsupported; online lookups may bypass the proxy");
            return;
        }
        try {
            // Names are the *Compat ones on purpose: androidx.webkit 1.12 dropped the older
            // ServiceWorkerClient / ServiceWorkerController classes in favour of these.
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    new ServiceWorkerClientCompat() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                            return serveRequest(request);
                        }
                    });
        } catch (Exception error) {
            Log.e(TAG, "Failed to install the service worker client", error);
        }
    }

    // ---- file chooser, fullscreen video, console --------------------------------------

    private final class FoliaChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(null);
            }
            fileChooserCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
            } catch (Exception error) {
                // Leaving the callback pending would make the page's file input hang forever.
                fileChooserCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            webView.setVisibility(View.GONE);
            rootLayout.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                    WindowManager.LayoutParams.FLAG_FULLSCREEN);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) {
                return;
            }
            rootLayout.removeView(customView);
            customView = null;
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
            }
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            if (immersiveEnabled) {
                applyImmersiveMode();
            }
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d(TAG, "[web] " + message.message() + " ("
                    + message.sourceId() + ":" + message.lineNumber() + ")");
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                // A multi-select answer arrives in ClipData while getData() stays null. Reading
                // only getData() hands the page an empty list, which the user experiences as
                // "I picked files and nothing happened".
                ClipData clip = data.getClipData();
                if (clip != null) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(results);
                fileChooserCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---- immersive fullscreen ----------------------------------------------------------

    /** Bridge entry point; may be called from the JavaScript bridge thread. */
    public void setImmersiveMode(boolean enabled) {
        if (immersiveEnabled == enabled) {
            return;
        }
        immersiveEnabled = enabled;
        runOnUiThread(this::applyImmersiveMode);
    }

    private void applyImmersiveMode() {
        Window window = getWindow();
        // A notch or punch-hole would otherwise be letterboxed into a black bar, in the
        // recents thumbnail too. The cutout constants only exist from API 28.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.layoutInDisplayCutoutMode = immersiveEnabled
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            window.setAttributes(attributes);
        }

        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller == null) {
                return;
            }
            window.setDecorFitsSystemWindows(!immersiveEnabled);
            if (immersiveEnabled) {
                controller.hide(WindowInsets.Type.systemBars());
                // Transient bars by swipe: a swipe reveals the bars without permanently
                // reflowing the page.
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                controller.show(WindowInsets.Type.systemBars());
            }
            return;
        }

        View decor = window.getDecorView();
        if (immersiveEnabled) {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The soft keyboard and system dialogs clear the system UI flags; re-apply on refocus.
        if (hasFocus && immersiveEnabled) {
            applyImmersiveMode();
        }
    }

    // ---- landscape guarantee -----------------------------------------------------------

    private View buildPortraitHint() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(getColor(R.color.portrait_hint_bg));

        TextView title = new TextView(this);
        title.setText(R.string.portrait_hint_title);
        title.setTextColor(getColor(R.color.portrait_hint_text));
        title.setTextSize(22f);
        title.setGravity(Gravity.CENTER);

        TextView body = new TextView(this);
        body.setText(R.string.portrait_hint_body);
        body.setTextColor(getColor(R.color.portrait_hint_accent));
        body.setTextSize(14f);
        body.setGravity(Gravity.CENTER);
        body.setPadding(48, 16, 48, 0);

        box.addView(title);
        box.addView(body);
        box.setVisibility(View.GONE);
        return box;
    }

    /**
     * The activity asks for landscape, but the OS rotation lock can override that request, so
     * the app must never be left showing a wide layout squeezed into a portrait viewport.
     */
    private void updatePortraitHint() {
        if (portraitHint == null) {
            return;
        }
        boolean portrait = getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_PORTRAIT;
        portraitHint.setVisibility(portrait ? View.VISIBLE : View.GONE);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        updatePortraitHint();
    }

    // ---- permissions, back, lifecycle --------------------------------------------------

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATION);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The media notification (and with it the lock-screen card) is gated on this permission.
        // Asking once at launch is not enough: a single accidental denial would silently remove
        // lock-screen control forever. Ask again only while the system still offers the dialog.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED
                && shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATION);
        }
        updatePortraitHint();
    }

    /**
     * Asks for the media-read permission the device library needs. Called from the bridge, so it may
     * arrive on the JavaScript bridge thread and has to be posted to the UI thread before the dialog
     * can be shown.
     *
     * The answer goes back to the page as a DOM event rather than a return value: the page calls this
     * from a click handler, and a permission dialog outlives that turn. One event name, dispatched
     * whether the user granted, denied or the dialog could not be shown at all - the page treats
     * every non-granted outcome the same way, by explaining the situation instead of retrying.
     */
    public void requestAudioPermission() {
        runOnUiThread(() -> {
            if (DeviceAudioLibrary.hasPermission(this)) {
                dispatchAudioPermission(true);
                return;
            }
            try {
                requestPermissions(
                        new String[]{ DeviceAudioLibrary.requiredPermission() },
                        REQ_AUDIO_PERMISSION);
            } catch (Exception unsupported) {
                Log.w(TAG, "Audio permission dialog unavailable: " + unsupported);
                dispatchAudioPermission(false);
            }
        });
    }

    /** Whether the device library is already readable; the page probes before showing anything. */
    public boolean hasAudioPermission() {
        return DeviceAudioLibrary.hasPermission(this);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode == REQ_AUDIO_PERMISSION) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            dispatchAudioPermission(granted);
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void dispatchAudioPermission(boolean granted) {
        runOnUiThread(() -> {
            if (webView == null) {
                return;
            }
            webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('folia-android-audio-permission',{detail:{granted:"
                            + granted + "}}));",
                    null);
        });
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            chromeClient.onHideCustomView();
            return;
        }
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // Reserved contract: with a page-side `data-folia-shell-overlay` marker the shell could
        // close the topmost modal before backgrounding, the way the desktop build's Escape
        // handling does. Upstream has no such marker yet, so back does not guess.
        moveTaskToBack(true);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
        outState.putBoolean(STATE_IMMERSIVE, immersiveEnabled);
    }

    @Override
    protected void onDestroy() {
        PlaybackService.setCommandSink(null);
        if (webView != null) {
            rootLayout.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
