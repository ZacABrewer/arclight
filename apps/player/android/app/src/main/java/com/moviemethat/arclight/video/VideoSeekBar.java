package com.moviemethat.arclight.video;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.ui.Ui;
import java.util.ArrayList;
import java.util.List;

/**
 * The scrub bar (§5.1 / §5.3), in media time: a 5 px track, the accent fill, a 16 px knob and a
 * 3 px notch in the background colour at every chapter start after 0. 24 px tall, sizes in stage
 * px (see {@link Ui}).
 *
 * <p>TV: Left / Right on the focused bar move a <em>preview</em> position (10 s steps, 30 s after
 * the key is held 1.5 s, 60 s after 3 s, {@link VideoTimeline#scrubStepMs}); Enter commits, Back
 * ({@link #cancelScrub}) or losing focus cancels. Enter without a preview toggles play. Touch: a
 * drag shows the preview and commits on release; a tap seeks there.
 */
public final class VideoSeekBar extends View {

    public interface Listener {
        /** The preview position moved (show the scrub preview). */
        void onScrubMove(long positionMs);

        /** Seek to {@code positionMs} (media time); the preview ends. */
        void onScrubCommit(long positionMs);

        /** The preview was dropped without seeking. */
        void onScrubCancel();

        /** Enter on the bar while not scrubbing. */
        void onBarSelect();

        /** Any key / touch on the bar (keeps the controls visible). */
        void onInteraction();
    }

    private final Ui ui;
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint knob = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint notch = new Paint();
    private final RectF rect = new RectF();

    private long durationMs;
    private long positionMs;
    private final List<Long> chapterStarts = new ArrayList<>();
    @Nullable private Listener listener;

    private boolean scrubbing;
    private long scrubMs;
    /** Down time of the held key (its repeats share it), for the hold acceleration. */
    private long holdDownTime = -1;

    @SuppressLint("ViewConstructor")
    public VideoSeekBar(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        track.setColor(ui.theme.track);
        fill.setColor(ui.theme.accent);
        knob.setColor(ui.theme.primaryBg);
        notch.setColor(ui.theme.bg);
        Ui.focusable(this, 8);
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    public void setChapters(List<VideoRequest.Chapter> chapters) {
        chapterStarts.clear();
        for (VideoRequest.Chapter c : chapters) if (c.startMs > 0) chapterStarts.add(c.startMs);
        invalidate();
    }

    /** Playback position (the preview, while scrubbing, is drawn instead). */
    public void setPosition(long positionMs, long durationMs) {
        this.durationMs = Math.max(0, durationMs);
        this.positionMs = Math.max(0, positionMs);
        invalidate();
    }

    public boolean isScrubbing() {
        return scrubbing;
    }

    public long scrubPosition() {
        return scrubMs;
    }

    /** Drops the preview (Back, a new item, focus lost). */
    public void cancelScrub() {
        holdDownTime = -1;
        if (!scrubbing) return;
        scrubbing = false;
        invalidate();
        Listener l = listener;
        if (l != null) l.onScrubCancel();
    }

    /** Knob centre for {@code ms}, in this view's px. */
    public float knobX(long ms) {
        float pad = pad();
        float w = Math.max(1, getWidth() - pad * 2);
        float f = durationMs > 0 ? Math.max(0, Math.min(1f, ms / (float) durationMs)) : 0;
        return pad + w * f;
    }

    // ---- input -------------------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            Listener l = listener;
            if (l != null) l.onInteraction();
            if (durationMs <= 0) return true;
            if (!scrubbing) {
                scrubbing = true;
                scrubMs = positionMs;
            }
            if (event.getRepeatCount() == 0 || holdDownTime < 0) holdDownTime = event.getDownTime();
            long held = Math.max(0, event.getEventTime() - holdDownTime);
            long step = VideoTimeline.scrubStepMs(held);
            scrubMs = VideoTimeline.clampSeek(scrubMs + (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ? step : -step), durationMs);
            moved();
            return true;
        }
        if (isEnter(keyCode)) {
            if (event.getRepeatCount() > 0) return true;
            if (scrubbing) commitScrub();
            else if (listener != null) listener.onBarSelect();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            holdDownTime = -1;
            return true;
        }
        if (isEnter(keyCode)) return true;
        return super.onKeyUp(keyCode, event);
    }

    static boolean isEnter(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (durationMs <= 0) return super.onTouchEvent(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
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
        if (!gainFocus && scrubbing && !isInTouchMode()) cancelScrub();
        invalidate();
    }

    private long timeAt(float x) {
        float pad = pad();
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
        holdDownTime = -1;
        if (!scrubbing) return;
        scrubbing = false;
        positionMs = scrubMs;
        invalidate();
        Listener l = listener;
        if (l != null) l.onScrubCommit(scrubMs);
    }

    /** The track spans the whole bar; the knob overhangs its ends (the parents do not clip). */
    private float pad() {
        return 0;
    }

    // ---- drawing -----------------------------------------------------------------------------

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        setMeasuredDimension(getDefaultSize(getSuggestedMinimumWidth(), widthMeasureSpec), resolveSize(ui.px(24), heightMeasureSpec));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float pad = pad();
        float w = getWidth() - pad * 2;
        float cy = getHeight() / 2f;
        float h = ui.pxf(5);
        float r = ui.pxf(3);
        long shown = scrubbing ? scrubMs : positionMs;
        float x = knobX(shown);

        rect.set(pad, cy - h / 2, pad + w, cy + h / 2);
        canvas.drawRoundRect(rect, r, r, track);
        if (x > pad) {
            rect.set(pad, cy - h / 2, x, cy + h / 2);
            canvas.drawRoundRect(rect, r, r, fill);
        }
        if (durationMs > 0) {
            float nw = ui.pxf(3);
            for (long start : chapterStarts) {
                if (start >= durationMs) continue;
                float nx = pad + w * (start / (float) durationMs);
                canvas.drawRect(nx - nw / 2, cy - h / 2, nx + nw / 2, cy + h / 2, notch);
            }
        }
        canvas.drawCircle(x, cy, ui.pxf(8), knob);
    }
}
