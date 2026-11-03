package com.moviemethat.arclight.video.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.video.OverlayStrings;
import com.moviemethat.arclight.video.OverlayTheme;

/**
 * Shared toolkit of the video overlay. Every size is given in design-stage px (the template's
 * 1280x720 TV stage) and converted with {@link #k} = stage scale x density, so the overlay looks
 * the same on a TV and a phone in landscape. Text sizes are in px too (stage px x k).
 */
public final class Ui {

    public final Context ctx;
    /** Screen px per stage px. */
    public final float k;
    public final OverlayTheme theme;
    public final OverlayStrings strings;
    public final boolean reduceMotion;
    /** Focus ring style: cyan glow instead of the white frame. */
    public final boolean cyanGlow;

    public Ui(Context ctx, float k, OverlayTheme theme, OverlayStrings strings, boolean reduceMotion, boolean cyanGlow) {
        this.ctx = ctx;
        this.k = k;
        this.theme = theme;
        this.strings = strings;
        this.reduceMotion = reduceMotion;
        this.cyanGlow = cyanGlow;
    }

    public int px(float stage) {
        if (stage == 0) return 0;
        int v = Math.round(stage * k);
        return v == 0 ? (stage > 0 ? 1 : -1) : v;
    }

    public float pxf(float stage) {
        return stage * k;
    }

    /** Figtree is web-only; natively the system sans at the closest weight. */
    public static Typeface font(int weight) {
        if (Build.VERSION.SDK_INT >= 28) return Typeface.create(Typeface.SANS_SERIF, weight, false);
        return weight >= 600 ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT;
    }

    public TextView text(float size, int weight, int color) {
        TextView v = new TextView(ctx);
        v.setTextSize(TypedValue.COMPLEX_UNIT_PX, pxf(size));
        v.setTypeface(font(weight));
        v.setTextColor(color);
        v.setIncludeFontPadding(false);
        return v;
    }

    public TextView line(float size, int weight, int color, int maxLines) {
        TextView v = text(size, weight, color);
        v.setMaxLines(maxLines);
        v.setEllipsize(TextUtils.TruncateAt.END);
        return v;
    }

    /** Letter spacing in em (CSS letter-spacing). */
    public static void tracking(TextView v, float em) {
        v.setLetterSpacing(em);
    }

    public static void tabular(TextView v) {
        v.setFontFeatureSettings("tnum");
    }

    public GradientDrawable round(int color, float radiusStage) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(pxf(radiusStage));
        return d;
    }

    public GradientDrawable round(int color, float radiusStage, int stroke, float strokeStage) {
        GradientDrawable d = round(color, radiusStage);
        d.setStroke(Math.max(1, px(strokeStage)), stroke);
        return d;
    }

    /** Marks {@code v} focusable for the remote, with the focus ring's corner radius (stage px). */
    public static void focusable(View v, float radiusStage) {
        v.setFocusable(true);
        v.setClickable(true);
        v.setTag(R.id.video_focus_radius, radiusStage);
        if (Build.VERSION.SDK_INT >= 26) v.setDefaultFocusHighlightEnabled(false);
    }

    /** A 52 px tall pill button with a fill (Next episode, Episodes, Audio & Subtitles). */
    public TextView pill(String label) {
        TextView v = text(16, 600, theme.text);
        v.setText(label);
        v.setGravity(Gravity.CENTER);
        v.setSingleLine(true);
        v.setPadding(px(22), 0, px(22), 0);
        v.setBackground(round(theme.fill, 26));
        focusable(v, 26);
        return v;
    }

    /** A 52 px circle with a centred label (−10 / +10). */
    public TextView circle(String label) {
        TextView v = text(15, 700, theme.text);
        v.setText(label);
        v.setGravity(Gravity.CENTER);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(theme.fill);
        v.setBackground(d);
        focusable(v, 26);
        return v;
    }

    public LinearLayout.LayoutParams lin(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public FrameLayout.LayoutParams frame(int w, int h, int gravity) {
        return new FrameLayout.LayoutParams(w, h, gravity);
    }

    public static final int WRAP = -2;
    public static final int MATCH = -1;

    /** Fade-in/out duration, 0 with reduce motion. */
    public long anim(long ms) {
        return reduceMotion ? 0 : ms;
    }
}
