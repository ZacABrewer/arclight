package com.moviemethat.arclight.video;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.Handler;
import android.os.Looper;
import android.util.AttributeSet;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.List;

/**
 * The video seek bar, in media time: track, buffered range, progress (the brand gradient),
 * chapter gaps and a thumb. Focusable for TV remotes: D-pad left / right scrub (the step grows
 * while the key is held, see {@link VideoTimeline#seekStepMs}) and the seek is committed 600 ms
 * after the last press, or at once with OK. Touch drags scrub too.
 */
public final class VideoSeekBar extends View {

    public interface Listener {
        /** The scrub position moved (update the time label / preview). */
        void onScrubMove(long positionMs);

        /** Seek to {@code positionMs} (media time). */
        void onScrubCommit(long positionMs);

        /** Any key / touch on the bar (keeps the controls visible). */
        void onInteraction();
    }

    private static final long COMMIT_DELAY_MS = 600;

    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint buffered = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint progress = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint thumb = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint gap = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final float density;

    private long durationMs;
    private long positionMs;
    private long bufferedMs;
    private final List<Long> chapterStarts = new ArrayList<>();
    @Nullable private Listener listener;

    private boolean scrubbing;
    private long scrubMs;
    private int repeat;

    private final Runnable commit = this::commitScrub;

    public VideoSeekBar(Context context) {
        this(context, null);
    }

    public VideoSeekBar(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        density = getResources().getDisplayMetrics().density;
        track.setColor(0x33E9FDFF);
        buffered.setColor(0x55E9FDFF);
        thumb.setColor(0xFFE9FDFF);
        glow.setColor(0x666EF6FF);
        gap.setColor(0xFF02070A);
        setFocusable(true);
        setClickable(true);
        setDefaultFocusHighlightEnabledCompat();
    }

    private void setDefaultFocusHighlightEnabledCompat() {
        if (android.os.Build.VERSION.SDK_INT >= 26) setDefaultFocusHighlightEnabled(false);
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    public void setChapters(List<VideoRequest.Chapter> chapters) {
        chapterStarts.clear();
        for (VideoRequest.Chapter c : chapters) if (c.startMs > 0) chapterStarts.add(c.startMs);
        invalidate();
    }

    /** Playback position (ignored while the user scrubs). */
    public void setPosition(long positionMs, long bufferedMs, long durationMs) {
        this.durationMs = Math.max(0, durationMs);
        this.bufferedMs = Math.max(0, bufferedMs);
        if (!scrubbing) this.positionMs = Math.max(0, positionMs);
        invalidate();
    }

    public boolean isScrubbing() {
        return scrubbing;
    }

    /** Drops an unfinished scrub (a new item was loaded). */
    public void cancelScrub() {
        handler.removeCallbacks(commit);
        scrubbing = false;
        repeat = 0;
        invalidate();
    }

    // ---- input -------------------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (durationMs <= 0) return true;
            if (!scrubbing) {
                scrubbing = true;
                scrubMs = positionMs;
                repeat = 0;
            }
            long step = VideoTimeline.seekStepMs(event.getRepeatCount() > 0 ? event.getRepeatCount() : repeat);
            repeat++;
            scrubMs = VideoTimeline.clampSeek(scrubMs + (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ? step : -step), durationMs);
            handler.removeCallbacks(commit);
            moved();
            return true;
        }
        if ((keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) && scrubbing) {
            commitScrub();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if ((keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) && scrubbing) {
            handler.removeCallbacks(commit);
            handler.postDelayed(commit, COMMIT_DELAY_MS);
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (durationMs <= 0) return super.onTouchEvent(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                getParent().requestDisallowInterceptTouchEvent(true);
                handler.removeCallbacks(commit);
                scrubbing = true;
                scrubMs = timeAt(e.getX());
                moved();
                return true;
            case MotionEvent.ACTION_MOVE:
                if (scrubbing) {
                    scrubMs = timeAt(e.getX());
                    moved();
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (scrubbing) {
                    scrubMs = timeAt(e.getX());
                    commitScrub();
                }
                performClick();
                return true;
            case MotionEvent.ACTION_CANCEL:
                cancelScrub();
                return true;
            default:
                return super.onTouchEvent(e);
        }
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }

    @Override
    protected void onFocusChanged(boolean gainFocus, int direction, @Nullable android.graphics.Rect previouslyFocusedRect) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect);
        if (!gainFocus && scrubbing) commitScrub();
        invalidate();
    }

    private long timeAt(float x) {
        float pad = padX();
        float w = Math.max(1, getWidth() - pad * 2);
        float f = Math.max(0, Math.min(1, (x - pad) / w));
        return VideoTimeline.clampSeek((long) (f * durationMs), durationMs);
    }

    private void moved() {
        invalidate();
        Listener l = listener;
        if (l != null) {
            l.onInteraction();
            l.onScrubMove(scrubMs);
        }
    }

    private void commitScrub() {
        handler.removeCallbacks(commit);
        if (!scrubbing) return;
        scrubbing = false;
        repeat = 0;
        positionMs = scrubMs;
        invalidate();
        Listener l = listener;
        if (l != null) l.onScrubCommit(scrubMs);
    }

    // ---- drawing -----------------------------------------------------------------------------

    private float padX() {
        return 10 * density;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int h = (int) (28 * density);
        setMeasuredDimension(getDefaultSize(getSuggestedMinimumWidth(), widthMeasureSpec), resolveSize(h, heightMeasureSpec));
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        progress.setShader(new LinearGradient(padX(), 0, w - padX(), 0, 0xFF2F7BFF, 0xFF6EF6FF, Shader.TileMode.CLAMP));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        boolean focused = isFocused();
        float pad = padX();
        float w = getWidth() - pad * 2;
        float cy = getHeight() / 2f;
        float barH = (focused || scrubbing ? 6 : 4) * density;
        float r = barH / 2;
        long shown = scrubbing ? scrubMs : positionMs;
        float fPos = durationMs > 0 ? Math.min(1f, shown / (float) durationMs) : 0;
        float fBuf = durationMs > 0 ? Math.min(1f, bufferedMs / (float) durationMs) : 0;

        rect.set(pad, cy - r, pad + w, cy + r);
        canvas.drawRoundRect(rect, r, r, track);
        if (fBuf > 0) {
            rect.set(pad, cy - r, pad + w * fBuf, cy + r);
            canvas.drawRoundRect(rect, r, r, buffered);
        }
        if (fPos > 0) {
            rect.set(pad, cy - r, pad + w * fPos, cy + r);
            canvas.drawRoundRect(rect, r, r, progress);
        }
        // Chapter boundaries: small gaps in the bar.
        if (durationMs > 0) {
            float gw = 2 * density;
            for (long start : chapterStarts) {
                if (start >= durationMs) continue;
                float x = pad + w * (start / (float) durationMs);
                canvas.drawRect(x - gw / 2, cy - r - 1, x + gw / 2, cy + r + 1, gap);
            }
        }
        float tx = pad + w * fPos;
        if (focused || scrubbing) {
            canvas.drawCircle(tx, cy, 12 * density, glow);
            canvas.drawCircle(tx, cy, 8 * density, thumb);
        } else {
            canvas.drawCircle(tx, cy, 6 * density, thumb);
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        handler.removeCallbacks(commit);
        super.onDetachedFromWindow();
    }
}
