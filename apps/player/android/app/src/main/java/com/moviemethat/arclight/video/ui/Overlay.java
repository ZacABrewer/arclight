package com.moviemethat.arclight.video.ui;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.video.OverlayTheme;

/**
 * Root of the video overlay. Draws the focus ring above every child (the template's
 * {@code updateRing}: 6 px outset, 3 px border, radius = the element's radius + 6, moving over
 * 0.16 s): a white frame with a dark inner band, or a cyan glow. The ring follows the focused view
 * through scrolling and layout, fades with its ancestors and is hidden in touch mode. Taps that
 * no child takes go to {@link Listener#onBackgroundTap}.
 */
public final class Overlay extends FrameLayout {

    public interface Listener {
        void onBackgroundTap();

        /** A double tap (and each further quick tap) on the right half ({@code forward}) or the left half. */
        void onBackgroundDoubleTap(boolean forward);

        void onOverlaySizeChanged(int w, int h);
    }

    private static final float OUTSET = 6;
    private static final float BORDER = 3;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Rect tmp = new Rect();
    private final RectF from = new RectF();
    private final RectF drawn = new RectF();
    private boolean hasDrawn;
    private float fromRadius;
    private float drawnRadius;
    private float t = 1f;
    @Nullable private ValueAnimator anim;
    @Nullable private View target;
    @Nullable private Ui ui;
    @Nullable private Listener listener;
    private boolean ringHidden;
    private float downX;
    private float downY;
    private boolean tapCandidate;
    /** Phones: a tap waits for the double-tap timeout before it counts as a single tap. */
    private boolean doubleTaps;
    private long lastTapAt;
    private float lastTapX;
    private float lastTapY;
    /** After a double tap, further taps on the same side until then seek again. */
    private long streakUntil;
    private boolean streakForward;
    private final Runnable singleTap = () -> {
        if (listener != null) listener.onBackgroundTap();
    };

    private final ViewTreeObserver.OnGlobalFocusChangeListener focusListener = (oldFocus, newFocus) -> onFocusMoved(newFocus);
    private final ViewTreeObserver.OnScrollChangedListener scrollListener = this::invalidate;
    private final ViewTreeObserver.OnGlobalLayoutListener layoutListener = this::invalidate;
    private final ViewTreeObserver.OnTouchModeChangeListener touchListener = inTouch -> invalidate();

    public Overlay(Context context) {
        this(context, null);
    }

    public Overlay(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        setWillNotDraw(false);
        paint.setStyle(Paint.Style.STROKE);
    }

    public void setUi(Ui ui) {
        this.ui = ui;
        invalidate();
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    /** Hides the ring (pause screen, PiP). */
    public void setRingHidden(boolean hidden) {
        ringHidden = hidden;
        invalidate();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        ViewTreeObserver o = getViewTreeObserver();
        o.addOnGlobalFocusChangeListener(focusListener);
        o.addOnScrollChangedListener(scrollListener);
        o.addOnGlobalLayoutListener(layoutListener);
        o.addOnTouchModeChangeListener(touchListener);
    }

    @Override
    protected void onDetachedFromWindow() {
        ViewTreeObserver o = getViewTreeObserver();
        o.removeOnGlobalFocusChangeListener(focusListener);
        o.removeOnScrollChangedListener(scrollListener);
        o.removeOnGlobalLayoutListener(layoutListener);
        o.removeOnTouchModeChangeListener(touchListener);
        if (anim != null) anim.cancel();
        removeCallbacks(singleTap);
        super.onDetachedFromWindow();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        Listener l = listener;
        if (l != null && (w != oldw || h != oldh)) post(() -> l.onOverlaySizeChanged(w, h));
    }

    private void onFocusMoved(@Nullable View v) {
        target = v != null && isDescendant(v) ? v : null;
        if (anim != null) anim.cancel();
        Ui u = ui;
        if (target == null || u == null || u.reduceMotion || !hasDrawn) {
            t = 1f;
            invalidate();
            return;
        }
        from.set(drawn);
        fromRadius = drawnRadius;
        t = 0f;
        ValueAnimator a = ValueAnimator.ofFloat(0f, 1f);
        a.setDuration(160);
        a.setInterpolator(new DecelerateInterpolator());
        a.addUpdateListener(x -> {
            t = (float) x.getAnimatedValue();
            invalidate();
        });
        anim = a;
        a.start();
    }

    private boolean isDescendant(View v) {
        ViewParent p = v.getParent();
        while (p != null) {
            if (p == this) return true;
            p = p.getParent();
        }
        return false;
    }

    /** Product of the alphas from {@code v} up to this view (a fading row fades its ring). */
    private float chainAlpha(View v) {
        float a = 1f;
        View cur = v;
        while (cur != null && cur != this) {
            a *= cur.getAlpha();
            ViewParent p = cur.getParent();
            cur = p instanceof View ? (View) p : null;
        }
        return a;
    }

    @Override
    protected void dispatchDraw(Canvas canvas) {
        super.dispatchDraw(canvas);
        drawRing(canvas);
    }

    private void drawRing(Canvas canvas) {
        Ui u = ui;
        View v = target;
        if (v == null || !v.isFocused()) {
            // Focus given before this listened (the play button when the player opens) never
            // reached onFocusMoved: ring whatever holds it now.
            View f = findFocus();
            if (f != null && f != this) v = target = f;
        }
        if (u == null || v == null || ringHidden || isInTouchMode() || !v.isShown() || !v.isFocused() || !isDescendant(v)) {
            hasDrawn = false;
            return;
        }
        float alpha = chainAlpha(v);
        if (alpha <= 0.01f) {
            hasDrawn = false;
            return;
        }
        // The drawing rect, not 0,0-w,h: a single-line TextView (the pill buttons) scrolls its own
        // content, and the offset below subtracts that scroll, which put their ring off screen.
        v.getDrawingRect(tmp);
        offsetDescendantRectToMyCoords(v, tmp);
        float o = u.pxf(OUTSET);
        Object tag = v.getTag(R.id.video_focus_radius);
        float rad = tag instanceof Float ? (Float) tag : 0f;
        rad = Math.min(u.pxf(rad), Math.min(tmp.width(), tmp.height()) / 2f);
        float left = tmp.left - o + v.getTranslationX();
        float top = tmp.top - o + v.getTranslationY();
        float right = tmp.right + o + v.getTranslationX();
        float bottom = tmp.bottom + o + v.getTranslationY();
        float radius = rad + o;
        if (t < 1f) {
            left = lerp(from.left, left);
            top = lerp(from.top, top);
            right = lerp(from.right, right);
            bottom = lerp(from.bottom, bottom);
            radius = lerp(fromRadius, radius);
        }
        drawn.set(left, top, right, bottom);
        drawnRadius = radius;
        hasDrawn = true;

        OverlayTheme th = u.theme;
        float b = u.pxf(BORDER);
        if (u.cyanGlow) {
            // box-shadow 0 0 24px accent@.55 (outside) and inset 0 0 12px accent@.25, drawn as rings.
            int steps = 8;
            float step = u.pxf(3);
            for (int i = 1; i <= steps; i++) {
                float d = i * step;
                float f = 1f - (i - 0.5f) / steps;
                stroke(canvas, th.accent, 0.55f * f * f * alpha, step, inset(drawn, -d + step / 2f), radius + d - step / 2f);
            }
            float istep = u.pxf(2);
            for (int i = 1; i <= 5; i++) {
                float d = b + (i - 0.5f) * istep;
                float f = 1f - (i - 0.5f) / 5f;
                stroke(canvas, th.accent, 0.25f * f * alpha, istep, inset(drawn, d), Math.max(0, radius - d));
            }
            stroke(canvas, th.accent, alpha, b, inset(drawn, b / 2f), radius - b / 2f);
        } else {
            stroke(canvas, OverlayTheme.alpha(th.bg, 0.85f), alpha, b, inset(drawn, b * 1.5f), Math.max(0, radius - b * 1.5f));
            stroke(canvas, 0xFFFFFFFF, alpha, b, inset(drawn, b / 2f), radius - b / 2f);
        }
    }

    private final RectF r2 = new RectF();

    private RectF inset(RectF r, float d) {
        r2.set(r.left + d, r.top + d, r.right - d, r.bottom - d);
        return r2;
    }

    private void stroke(Canvas c, int color, float alpha, float width, RectF r, float radius) {
        paint.setColor(color);
        float own = ((color >>> 24) & 0xFF) / 255f;
        paint.setAlpha(Math.round(Math.max(0, Math.min(1, alpha * own)) * 255));
        paint.setStrokeWidth(width);
        c.drawRoundRect(r, radius, radius, paint);
    }

    private float lerp(float a, float b) {
        return a + (b - a) * t;
    }

    // ---- taps on the empty overlay -------------------------------------------------------------

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        int slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getX();
                downY = e.getY();
                tapCandidate = true;
                return true;
            case MotionEvent.ACTION_MOVE:
                if (Math.abs(e.getX() - downX) > slop || Math.abs(e.getY() - downY) > slop) tapCandidate = false;
                return true;
            case MotionEvent.ACTION_UP:
                if (tapCandidate && listener != null) {
                    performClick();
                    onTap(e);
                }
                tapCandidate = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                tapCandidate = false;
                return true;
            default:
                return super.onTouchEvent(e);
        }
    }

    /** Double taps on (true) or off; off, every tap is a single tap at once. */
    public void setDoubleTaps(boolean on) {
        doubleTaps = on;
        if (!on) {
            removeCallbacks(singleTap);
            streakUntil = 0;
        }
    }

    private void onTap(MotionEvent e) {
        if (!doubleTaps) {
            listener.onBackgroundTap();
            return;
        }
        long now = e.getEventTime();
        boolean forward = e.getX() > getWidth() / 2f;
        int timeout = ViewConfiguration.getDoubleTapTimeout();
        if (now < streakUntil && forward == streakForward) {
            streakUntil = now + timeout * 2L;
            listener.onBackgroundDoubleTap(forward);
            return;
        }
        int slop = ViewConfiguration.get(getContext()).getScaledDoubleTapSlop();
        boolean pending = now - lastTapAt <= timeout && Math.hypot(e.getX() - lastTapX, e.getY() - lastTapY) <= slop;
        if (pending) {
            removeCallbacks(singleTap);
            lastTapAt = 0;
            streakForward = forward;
            streakUntil = now + timeout * 2L;
            listener.onBackgroundDoubleTap(forward);
            return;
        }
        streakUntil = 0;
        lastTapAt = now;
        lastTapX = e.getX();
        lastTapY = e.getY();
        removeCallbacks(singleTap);
        postDelayed(singleTap, timeout);
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }
}
