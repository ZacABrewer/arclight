package com.moviemethat.arclight.video.ui;

import android.content.Context;
import android.view.FocusFinder;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import androidx.annotation.Nullable;

/**
 * A full-height panel on the right (Audio &amp; Subtitles 440, Episodes 520): panel background,
 * a 1 px left border in the line colour. It takes every tap inside it, and traps D-pad focus
 * ({@link #moveFocus}).
 */
public abstract class SidePanel extends FrameLayout {

    protected final Ui ui;
    private final int widthStage;

    protected SidePanel(Context context, Ui ui, int widthStage) {
        super(context);
        this.ui = ui;
        this.widthStage = widthStage;
        setBackgroundColor(ui.theme.panel);
        setClickable(true);
        setFocusable(false);
        View line = new View(context);
        line.setBackgroundColor(ui.theme.line);
        addView(line, ui.frame(Math.max(1, ui.px(1)), Ui.MATCH, Gravity.START));
        setVisibility(GONE);
    }

    public FrameLayout.LayoutParams params() {
        return ui.frame(ui.px(widthStage), Ui.MATCH, Gravity.END);
    }

    public boolean isOpen() {
        return getVisibility() == VISIBLE;
    }

    /** Opens the panel with the focus on {@link #initialFocus}. */
    public void open() {
        animate().cancel();
        setVisibility(VISIBLE);
        long d = ui.anim(200);
        if (d > 0) {
            // In from the right edge: 40 stage px and a fade.
            setTranslationX(ui.pxf(40));
            setAlpha(0f);
            animate().translationX(0f).alpha(1f).setDuration(d).setInterpolator(new DecelerateInterpolator())
                    // The overlay draws the focus ring: it follows the sliding row.
                    .setUpdateListener(a -> { if (getParent() instanceof View) ((View) getParent()).invalidate(); }).start();
        } else {
            setTranslationX(0f);
            setAlpha(1f);
        }
        View f = initialFocus();
        if (f != null) f.requestFocus();
    }

    public void close() {
        animate().cancel();
        setTranslationX(0f);
        setAlpha(1f);
        setVisibility(GONE);
    }

    @Nullable
    protected abstract View initialFocus();

    /**
     * D-pad inside the panel: moves to the next focusable in that direction within the panel, or
     * stays put (focus is trapped). True when the key was a direction key.
     */
    public boolean moveFocus(int keyCode) {
        int dir;
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP:
                dir = View.FOCUS_UP;
                break;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                dir = View.FOCUS_DOWN;
                break;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                dir = View.FOCUS_LEFT;
                break;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                dir = View.FOCUS_RIGHT;
                break;
            default:
                return false;
        }
        View focused = findFocus();
        if (focused == null) {
            View f = initialFocus();
            if (f != null) f.requestFocus();
            return true;
        }
        View next = FocusFinder.getInstance().findNextFocus(this, focused, dir);
        if (next != null) next.requestFocus(dir);
        return true;
    }
}
