package app.folia.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Online audio pulled into the shell's own memory, then handed back to the page over the virtual
 * origin.
 *
 * Why this exists: the signed audio URLs a provider hands out carry no `Access-Control-Allow-Origin`,
 * while the page's {@code <audio>} element is `crossOrigin="anonymous"` because the visualiser analyses
 * it with WebAudio. Loading the remote URL directly therefore fails — progress bar alive, no sound.
 * The same code runs in the HarmonyOS shell ({@code MediaCache.ets}); this class is its Java twin,
 * kept method-for-method so the page needs one implementation rather than one per platform.
 *
 * Why not just proxy byte ranges straight to the element: the page wants MSE for the first sound to
 * arrive before the whole file does, and MSE needs the page to append chunks itself. So this class
 * only *stores*; {@link MediaProxyHandler} serves slices out of it.
 *
 * Memory: at most {@link #MAX_ENTRIES} tracks, evicted oldest-first. Downloads are daemon threads, so
 * an unfinished one never keeps the process alive.
 */
public final class MediaCache {

    private static final String TAG = "FoliaShell";

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    /** Size of one stored block. The page slices what it needs out of these. */
    private static final int CHUNK_BYTES = 64 * 1024;
    /**
     * Current track + the one fading out + the prefetched next one. More than that and a single
     * 10 MB lossless track turns into hundreds of megabytes resident.
     */
    private static final int MAX_ENTRIES = 3;
    /** Refuse to grow a single entry past this; a runaway response must not exhaust the heap. */
    private static final long MAX_TRACK_BYTES = 96L * 1024 * 1024;

    /** What the page may ask about a token. */
    static final String STATE_PENDING = "pending";
    static final String STATE_PREPARING = "preparing";
    static final String STATE_READY = "ready";
    static final String STATE_FAILED = "failed";
    static final String STATE_MISSING = "missing";

    /** One track: state machine, arrival order preserved, plus the mime the CDN reported. */
    private static final class Entry {
        volatile String state = STATE_PENDING;
        /** CDNs sometimes omit the type; the page only asks MSE for mp3, so this is the safe default. */
        volatile String mime = "audio/mpeg";
        volatile boolean released;
        final List<byte[]> chunks = new ArrayList<>();
        long received;

        void append(byte[] chunk) {
            chunks.add(chunk);
            received += chunk.length;
        }
    }

    /** Read-only view for the proxy: enough to build a response without holding the lock. */
    static final class Snapshot {
        final String mime;
        final long received;
        final String state;

        Snapshot(String mime, long received, String state) {
            this.mime = mime;
            this.received = received;
            this.state = state;
        }
    }

    private static final Map<Integer, Entry> ENTRIES = new LinkedHashMap<>();
    private static int nextToken = 1;

    private MediaCache() {
    }

    /**
     * Starts pulling a track in; returns the token immediately so the page can poll.
     *
     * Never blocks: the bridge method this backs runs on the WebView's JavaScript thread, and a
     * single-digit-megabyte download there would freeze the page.
     */
    public static int prepare(Context context, String url) {
        Entry entry = new Entry();
        int token;
        synchronized (ENTRIES) {
            token = nextToken++;
            ENTRIES.put(token, entry);
            evictOldestLocked();
        }

        // Offline: the connect timeout alone would be ten seconds of the page waiting on a failure
        // it can see for itself. Answer now and let the player show its network error.
        if (!isOnline(context)) {
            entry.state = STATE_FAILED;
            Log.i(TAG, "media prepare skipped (offline) token=" + token);
            return token;
        }

        Thread reader = new Thread(() -> download(url, entry, token), "folia-media-" + token);
        reader.setDaemon(true);
        reader.start();
        return token;
    }

    static String status(int token) {
        Entry entry;
        synchronized (ENTRIES) {
            entry = ENTRIES.get(token);
        }
        return entry == null ? STATE_MISSING : entry.state;
    }

    /** Bytes that have arrived so far. The page decides which slice it can ask for from this. */
    static long progress(int token) {
        Entry entry;
        synchronized (ENTRIES) {
            entry = ENTRIES.get(token);
        }
        if (entry == null) {
            return 0L;
        }
        synchronized (entry) {
            return entry.received;
        }
    }

    /** State summary for the proxy. Null means "no such token", not "nothing arrived yet". */
    static Snapshot snapshot(int token) {
        Entry entry;
        synchronized (ENTRIES) {
            entry = ENTRIES.get(token);
        }
        if (entry == null) {
            return null;
        }
        synchronized (entry) {
            return new Snapshot(entry.mime, entry.received, entry.state);
        }
    }

    /**
     * Copies {@code [from, to)} — clamped to what has arrived — into one array.
     *
     * Only that span is copied, so a page taking 256 KiB at a time moves 256 KiB, not the track.
     */
    static byte[] slice(int token, long from, long to) {
        Entry entry;
        synchronized (ENTRIES) {
            entry = ENTRIES.get(token);
        }
        if (entry == null) {
            return null;
        }
        synchronized (entry) {
            long available = entry.received;
            if (available == 0L) {
                return null;
            }
            long start = Math.max(0L, from);
            long end = Math.min(to, available);
            if (end <= start) {
                return null;
            }
            byte[] out = new byte[(int) (end - start)];
            int written = 0;
            long chunkStart = 0L;
            for (byte[] chunk : entry.chunks) {
                long chunkEnd = chunkStart + chunk.length;
                if (chunkEnd <= start) {
                    chunkStart = chunkEnd;
                    continue;
                }
                if (chunkStart >= end) {
                    break;
                }
                int localFrom = (int) Math.max(0L, start - chunkStart);
                int localTo = (int) Math.min(chunk.length, end - chunkStart);
                System.arraycopy(chunk, localFrom, out, written, localTo - localFrom);
                written += localTo - localFrom;
                chunkStart = chunkEnd;
            }
            if (written == 0) {
                return null;
            }
            if (written == out.length) {
                return out;
            }
            byte[] trimmed = new byte[written];
            System.arraycopy(out, 0, trimmed, 0, written);
            return trimmed;
        }
    }

    static void release(int token) {
        Entry entry;
        synchronized (ENTRIES) {
            entry = ENTRIES.remove(token);
        }
        if (entry != null) {
            synchronized (entry) {
                entry.released = true;
            }
        }
    }

    /** Drops every track; called when the activity goes away so nothing outlives the WebView. */
    static void clearAll() {
        synchronized (ENTRIES) {
            for (Entry entry : ENTRIES.values()) {
                synchronized (entry) {
                    entry.released = true;
                }
            }
            ENTRIES.clear();
        }
    }

    // ---- download ------------------------------------------------------------------------

    private static void download(String url, Entry entry, int token) {
        HttpURLConnection connection = null;
        InputStream body = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod("GET");
            // A transparent transfer would hand the page a gzip stream it cannot decode as audio,
            // and `identity` also keeps byte offsets equal to track offsets.
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Range", "bytes=0-");
            connection.connect();

            int code = connection.getResponseCode();
            if (code >= 400) {
                throw new IOException("HTTP " + code);
            }
            entry.mime = mimeOf(connection.getContentType());
            body = connection.getInputStream();

            byte[] buffer = new byte[CHUNK_BYTES];
            int read;
            while ((read = body.read(buffer)) > 0) {
                if (read != buffer.length) {
                    byte[] exact = new byte[read];
                    System.arraycopy(buffer, 0, exact, 0, read);
                    buffer = exact;
                }
                synchronized (entry) {
                    if (entry.released) {
                        // The page moved on; stop paying for bytes nobody will ask for.
                        Log.i(TAG, "media download abandoned token=" + token);
                        return;
                    }
                    entry.append(buffer);
                    if (entry.state.equals(STATE_PENDING)) {
                        entry.state = STATE_PREPARING;
                    }
                    if (entry.received > MAX_TRACK_BYTES) {
                        entry.state = STATE_FAILED;
                        Log.w(TAG, "media download over " + MAX_TRACK_BYTES + " bytes token=" + token);
                        return;
                    }
                }
                buffer = new byte[CHUNK_BYTES];
            }

            synchronized (entry) {
                if (!entry.released) {
                    entry.state = STATE_READY;
                }
            }
            Log.i(TAG, "media ready: " + entry.received + " bytes " + entry.mime + " token=" + token);
        } catch (Exception error) {
            synchronized (entry) {
                if (!entry.released) {
                    entry.state = STATE_FAILED;
                }
            }
            Log.w(TAG, "media download failed token=" + token + ": " + error);
        } finally {
            if (body != null) {
                try {
                    body.close();
                } catch (Exception ignored) {
                    // Nothing to recover: the entry already carries the outcome.
                }
            }
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    // ---- helpers -------------------------------------------------------------------------

    /** Oldest tokens go first; the pre-existing entry is never the one being added. */
    private static void evictOldestLocked() {
        while (ENTRIES.size() > MAX_ENTRIES) {
            Integer oldest = null;
            for (Integer key : ENTRIES.keySet()) {
                if (oldest == null || key < oldest) {
                    oldest = key;
                }
            }
            if (oldest == null) {
                return;
            }
            Entry dropped = ENTRIES.remove(oldest);
            if (dropped != null) {
                synchronized (dropped) {
                    dropped.released = true;
                }
            }
            Log.i(TAG, "media evicted token=" + oldest);
        }
    }

    private static String mimeOf(String contentType) {
        if (contentType == null || contentType.isEmpty()) {
            return "audio/mpeg";
        }
        int semicolon = contentType.indexOf(';');
        String mime = semicolon > 0 ? contentType.substring(0, semicolon).trim() : contentType.trim();
        // Providers occasionally answer with octet-stream; the page only opens this through MSE,
        // which is told audio/mpeg, so anything that is not audio/ collapses to that.
        return mime.toLowerCase(Locale.US).startsWith("audio/") ? mime : "audio/mpeg";
    }

    private static boolean isOnline(Context context) {
        if (context == null) {
            return true;
        }
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) {
                return true;
            }
            Network network = manager.getActiveNetwork();
            if (network == null) {
                return false;
            }
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            return capabilities != null
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception unknown) {
            // An unanswerable question is not a reason to refuse to download.
            return true;
        }
    }
}
