package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.view.Gravity;
import android.widget.FrameLayout;
import androidx.appcompat.widget.AppCompatTextView;
import com.moviemethat.arclight.video.OverlayMetrics;
import com.moviemethat.arclight.video.OverlayTheme;

/**
 * "Skip Intro" / "Skip Recap" / "Skip Credits" (§5.6) as drawn in the template: bottom-right at
 * right 56, bottom 168 with the controls shown and 48 hidden; 46 tall, padding 0 22, radius 8,
 * 16/700, background rgba(17,19,22,.72) with a 1 px white .4 border.
 */
@SuppressLint("ViewConstructor")
public final class SkipButton extends AppCompatTextView {

    private final Ui ui;

    public SkipButton(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, ui.pxf(16));
        setTypeface(Ui.font(700));
        setTextColor(ui.theme.text);
        setIncludeFontPadding(false);
        setGravity(Gravity.CENTER);
        setSingleLine(true);
        setPadding(ui.px(22), 0, ui.px(22), 0);
        setBackground(ui.round(OverlayTheme.alpha(ui.theme.bg, 0.72f), 8, OverlayTheme.alpha(0xFFFFFFFF, 0.4f), 1));
        Ui.focusable(this, 8);
        setVisibility(GONE);
    }

    public FrameLayout.LayoutParams params() {
        FrameLayout.LayoutParams p = ui.frame(Ui.WRAP, ui.px(46), Gravity.BOTTOM | Gravity.END);
        p.rightMargin = ui.px(OverlayMetrics.SIDE);
        p.bottomMargin = ui.px(OverlayMetrics.cornerBottom(true));
        return p;
    }

    /** Moves with the controls (bottom 168 shown / 48 hidden). */
    public void setControlsShown(boolean shown) {
        FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) getLayoutParams();
        int b = ui.px(OverlayMetrics.cornerBottom(shown));
        if (p != null && p.bottomMargin != b) {
            p.bottomMargin = b;
            setLayoutParams(p);
        }
    }
}
