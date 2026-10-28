package app.folia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.view.View;

/**
 * The native startup animation: a full-screen view stacked above the WebView, playing from the
 * first frame of the activity.
 *
 * Why it exists at all: the system launch window shows the app icon on a flat colour, and the
 * web splash can only appear once index.html and the JS bundle have been parsed. In between there
 * is a bare-colour frame, which is exactly what "it flashes black on cold start" looks like. This
 * view covers that gap and then hands over to the page.
 *
 * The motion is deliberately a mirror of the HarmonyOS shell's shell/StartupSplash.ets and of
 * index.html's inline splash: five letters of "Folia" rise out of a blur, a row of thirteen bars
 * grows underneath and keeps breathing, and the whole layer pushes in slightly while fading out.
 *
 * Timing contract (same numbers as the HarmonyOS side):
 *   0ms      background, nothing else
 *   80ms     letters start, 55ms apart, 620ms each
 *   460ms    bars fade in, 12ms apart
 *   700ms    bars start breathing (independent speeds)
 *   >=1150ms leave, but only once the page has reported its first paint
 *   2600ms    leave regardless (the page never reported: an old bundle, or a broken one)
 *
 * Everything is drawn on a single Canvas from the elapsed clock, so there is no animator
 * bookkeeping and the intro can be cut short at any point without leaving the view in a
 * half-animated state.
 */
final class StartupSplashView extends View {

    /** Told when the view is done: the activity should remove it. Always on the UI thread. */
    interface Listener {
        void onSplashFinished();
    }

    private static final int MIN_VISIBLE_MS = 1150;
    private static final int MAX_VISIBLE_MS = 2600;
    private static final int EXIT_MS = 300;

    private static final int LETTER_START_MS = 80;
    private static final int LETTER_STAGGER_MS = 55;
    private static final int LETTER_MS = 620;

    private static final int BARS_AT_MS = 460;
    private static final int BARS_FADE_MS = 240;

    private static final String[] LETTERS = {"F", "o", "l", "i", "a"};
    private static final int BAR_COUNT = 13;

    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint barPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint haloPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF barRect = new RectF();

    /** Per-bar shape: the envelope in the middle, randomness on top (same recipe as the web). */
    private final float[] barPeaks = new float[BAR_COUNT];
    private final float[] barFloors = new float[BAR_COUNT];
    private final float[] barWidths = new float[BAR_COUNT];
    private final int[] barDurations = new int[BAR_COUNT];
    private final float[] barCenters = new float[BAR_COUNT];

    private float fontSize;
    private float baselineY;
    private float waveCenterY;
    private float waveHeight;
    private float haloRadius;

    private long startAt = SystemClock.uptimeMillis();
    private long exitStartAt = -1L;
    private boolean ready;
    private boolean readyCheckScheduled;
    private boolean finished;
    private Listener listener;

    StartupSplashView(Context context) {
        super(context);
        setBackgroundColor(Color.rgb(0x07, 0x07, 0x07));
        // Swallow touches while it is up: the UI underneath is not visible yet, and a stray
        // tap that lands on the not-yet-rendered library would be a surprise.
        setClickable(true);
        seedBars();
        // Bold by default: the wordmark is meant to read like an iOS system title.
        textPaint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        textPaint.setColor(Color.WHITE);
        textPaint.setTextAlign(Paint.Align.LEFT);
        barPaint.setColor(Color.WHITE);
        haloPaint.setColor(Color.WHITE);
    }

    void setListener(Listener value) {
        this.listener = value;
    }

    /** The page painted its first frame. Safe to call from the JavaScript bridge thread. */
    void markReady() {
        if (ready) {
            return;
        }
        ready = true;
        post(() -> {
            if (finished || exitStartAt >= 0) {
                return;
            }
            if (!readyCheckScheduled) {
                readyCheckScheduled = true;
                long elapsed = SystemClock.uptimeMillis() - startAt;
                long wait = Math.max(0L, MIN_VISIBLE_MS - elapsed);
                postDelayed(this::beginExit, wait);
            }
        });
    }

    private void seedBars() {
        for (int i = 0; i < BAR_COUNT; i++) {
            double envelope = Math.sin(((i + 0.5) / BAR_COUNT) * Math.PI);
            barPeaks[i] = (float) Math.min(1.0, 0.34 + envelope * (0.4 + Math.random() * 0.3));
            barFloors[i] = (float) (0.1 + Math.random() * 0.16);
            barWidths[i] = (float) (3.6 + Math.random() * 2.6);
            barDurations[i] = (int) Math.round(880 + Math.random() * 520);
        }
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        startAt = SystemClock.uptimeMillis();
        postDelayed(this::beginExit, MAX_VISIBLE_MS);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        fontSize = Math.min(w * 0.17f, h * 0.42f);
        textPaint.setTextSize(fontSize);
        textPaint.setShadowLayer(fontSize * 0.09f, 0f, 0f, 0x66FFFFFF);

        float contentGap = waveHeightFrom(w, h) * 0.42f;
        waveHeight = waveHeightFrom(w, h);
        float total = fontSize + contentGap + waveHeight;
        float top = (h - total) / 2f;
        baselineY = top + fontSize * 0.82f;
        waveCenterY = top + fontSize + contentGap + waveHeight / 2f;
        haloRadius = Math.min(w * 0.62f, h * 1.25f);

        float gap = Math.min(w * 0.011f, 40f);
        float sum = 0f;
        for (int i = 0; i < BAR_COUNT; i++) {
            // Bar widths are authored in CSS-pixel terms; scale them with the font so a tablet
            // does not end up with hairlines.
            barWidths[i] = barWidths[i] * fontSize / 140f;
            sum += barWidths[i];
        }
        sum += gap * (BAR_COUNT - 1);
        float cursor = (w - sum) / 2f;
        for (int i = 0; i < BAR_COUNT; i++) {
            barCenters[i] = cursor + barWidths[i] / 2f;
            cursor += barWidths[i] + gap;
        }

        haloPaint.setShader(new RadialGradient(w / 2f, h / 2f, haloRadius,
                new int[]{0x1AFFFFFF, 0x09FFFFFF, 0x00FFFFFF},
                new float[]{0f, 0.35f, 0.68f}, Shader.TileMode.CLAMP));
    }

    private float waveHeightFrom(int w, int h) {
        return Math.min(w * 0.075f, h * 0.24f);
    }

    private void beginExit() {
        if (finished || exitStartAt >= 0) {
            return;
        }
        exitStartAt = SystemClock.uptimeMillis();
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        long now = SystemClock.uptimeMillis();
        long elapsed = now - startAt;

        float exitProgress = exitStartAt < 0 ? 0f : Math.min(1f, (now - exitStartAt) / (float) EXIT_MS);
        float contentAlpha = 1f - exitProgress;

        canvas.drawColor(Color.rgb(0x07, 0x07, 0x07));

        canvas.save();
        if (exitProgress > 0f) {
            float push = 1f + 0.035f * exitProgress;
            canvas.scale(push, push, getWidth() / 2f, getHeight() / 2f);
        }

        drawHalo(canvas, elapsed, contentAlpha);
        drawWordmark(canvas, elapsed, contentAlpha);
        drawWave(canvas, elapsed, contentAlpha);

        canvas.restore();

        if (exitProgress > 0f) {
            setAlpha(contentAlpha);
        }

        if (exitProgress >= 1f) {
            finishOnce();
            return;
        }
        postInvalidateOnAnimation();
    }

    private void drawHalo(Canvas canvas, long elapsed, float contentAlpha) {
        float p = clamp01(elapsed / 1400f);
        float eased = 1f - (1f - p) * (1f - p) * (1f - p);
        float scale = 0.86f + 0.14f * eased;
        haloPaint.setAlpha((int) (255f * 0.72f * eased * contentAlpha));

        canvas.save();
        canvas.scale(scale, scale, getWidth() / 2f, getHeight() / 2f);
        canvas.drawCircle(getWidth() / 2f, getHeight() / 2f, haloRadius, haloPaint);
        canvas.restore();
    }

    private void drawWordmark(Canvas canvas, long elapsed, float contentAlpha) {
        float totalWidth = 0f;
        for (String letter : LETTERS) {
            totalWidth += textPaint.measureText(letter);
        }

        float cursor = getWidth() / 2f - totalWidth / 2f;
        for (int i = 0; i < LETTERS.length; i++) {
            String letter = LETTERS[i];
            float width = textPaint.measureText(letter);
            float p = clamp01((elapsed - (LETTER_START_MS + i * LETTER_STAGGER_MS)) / (float) LETTER_MS);
            float eased = 1f - (1f - p) * (1f - p) * (1f - p);
            float shift = (1f - eased) * fontSize * 0.16f;
            float scale = 0.94f + 0.06f * eased;

            textPaint.setAlpha((int) (255f * eased * contentAlpha));
            canvas.save();
            canvas.scale(scale, scale, cursor + width / 2f, baselineY);
            canvas.drawText(letter, cursor, baselineY + shift, textPaint);
            canvas.restore();

            cursor += width;
        }
    }

    private void drawWave(Canvas canvas, long elapsed, float contentAlpha) {
        for (int i = 0; i < BAR_COUNT; i++) {
            float intro = clamp01((elapsed - (BARS_AT_MS + i * 12f)) / (float) BARS_FADE_MS);

            // One smooth up-down per period: an alternating ease-in-out without an Animator.
            float breatheAt = elapsed - (BARS_AT_MS + BARS_FADE_MS);
            float phase = breatheAt <= 0f ? 0f : (breatheAt % barDurations[i]) / (float) barDurations[i];
            float wave = 0.5f - 0.5f * (float) Math.cos(2.0 * Math.PI * phase);

            float scaleY = barFloors[i] + (barPeaks[i] - barFloors[i]) * wave;
            float half = waveHeight * scaleY / 2f;
            float width = barWidths[i];

            barRect.set(barCenters[i] - width / 2f, waveCenterY - half,
                    barCenters[i] + width / 2f, waveCenterY + half);
            barPaint.setAlpha((int) (255f * intro * contentAlpha));
            barPaint.setShadowLayer(width * 2.4f, 0f, 0f, 0x4DFFFFFF);
            canvas.drawRoundRect(barRect, width / 2f, width / 2f, barPaint);
        }
    }

    private void finishOnce() {
        if (finished) {
            return;
        }
        finished = true;
        Listener target = listener;
        listener = null;
        if (target != null) {
            target.onSplashFinished();
        }
    }

    private static float clamp01(float value) {
        if (value < 0f) {
            return 0f;
        }
        return Math.min(value, 1f);
    }
}
