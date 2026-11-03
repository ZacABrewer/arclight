package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.OverlayMetrics;
import com.moviemethat.arclight.video.VideoRequest;

/**
 * The up-next card (§5.5): bottom-right where Skip sits, 420 wide, radius 8, panel background.
 * A 160x90 thumbnail; "UP NEXT" (13/700, accent, .08em); the title (17/700) and sub line; "Play
 * now" (primary, 40 tall) and "Cancel"; "Next episode in 8s" and a 3 px accent bar draining along
 * the bottom edge. Without autoplay: "Play now" only, no countdown and no bar. With reduce motion
 * the bar stands still (the text still counts).
 */
@SuppressLint("ViewConstructor")
public final class UpNextCard extends FrameLayout {

    private final Ui ui;
    private final ImageLoader images;
    private final ImageView thumb;
    private final TextView title;
    private final TextView subtitle;
    private final TextView countdown;
    public final TextView playNow;
    public final TextView cancel;
    private final DrainBar bar;
    private boolean autoplay = true;

    public UpNextCard(Context context, Ui ui, ImageLoader images) {
        super(context);
        this.ui = ui;
        this.images = images;
        setBackground(ui.round(ui.theme.panel, 8));
        setClipToOutline(true);
        setClickable(true);

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(ui.px(16), ui.px(16), ui.px(16), ui.px(16));
        row.setClipChildren(false);
        thumb = new ImageView(context);
        thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        thumb.setBackground(ui.round(ui.theme.fill, ui.theme.radiusTile));
        thumb.setClipToOutline(true);
        row.addView(thumb, ui.lin(ui.px(160), ui.px(90)));

        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setClipChildren(false);
        TextView label = ui.text(13, 700, ui.theme.accent);
        Ui.tracking(label, 0.08f);
        label.setAllCaps(true);
        label.setText(ui.strings.get("upNext"));
        col.addView(label, ui.lin(Ui.WRAP, Ui.WRAP));
        title = ui.line(17, 700, ui.theme.text, 2);
        col.addView(title, top(ui.lin(Ui.MATCH, Ui.WRAP), 6));
        subtitle = ui.line(14, 400, ui.theme.text2, 1);
        col.addView(subtitle, top(ui.lin(Ui.MATCH, Ui.WRAP), 4));

        LinearLayout buttons = new LinearLayout(context);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER_VERTICAL);
        buttons.setClipChildren(false);
        playNow = button(ui.strings.get("playNow"), true);
        buttons.addView(playNow, ui.lin(Ui.WRAP, ui.px(40)));
        cancel = button(ui.strings.get("cancel"), false);
        LinearLayout.LayoutParams cl = ui.lin(Ui.WRAP, ui.px(40));
        cl.leftMargin = ui.px(10);
        buttons.addView(cancel, cl);
        col.addView(buttons, top(ui.lin(Ui.WRAP, Ui.WRAP), 12));
        countdown = ui.text(13, 400, ui.theme.text3);
        Ui.tabular(countdown);
        col.addView(countdown, top(ui.lin(Ui.WRAP, Ui.WRAP), 10));

        LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(0, Ui.WRAP, 1f);
        colLp.leftMargin = ui.px(16);
        row.addView(col, colLp);
        addView(row, ui.frame(Ui.MATCH, Ui.WRAP, Gravity.TOP));

        bar = new DrainBar(context);
        addView(bar, ui.frame(Ui.MATCH, ui.px(3), Gravity.BOTTOM));
        setVisibility(GONE);
    }

    private LinearLayout.LayoutParams top(LinearLayout.LayoutParams p, int m) {
        p.topMargin = ui.px(m);
        return p;
    }

    private TextView button(String text, boolean primary) {
        TextView v = ui.text(15, 700, primary ? ui.theme.primaryText : ui.theme.text);
        v.setText(text);
        v.setGravity(Gravity.CENTER);
        v.setSingleLine(true);
        v.setPadding(ui.px(18), 0, ui.px(18), 0);
        v.setBackground(ui.round(primary ? ui.theme.primaryBg : ui.theme.fill, ui.theme.radiusButton));
        Ui.focusable(v, ui.theme.radiusButton);
        return v;
    }

    public FrameLayout.LayoutParams params() {
        FrameLayout.LayoutParams p = ui.frame(ui.px(420), Ui.WRAP, Gravity.BOTTOM | Gravity.END);
        p.rightMargin = ui.px(OverlayMetrics.SIDE);
        p.bottomMargin = ui.px(OverlayMetrics.cornerBottom(true));
        return p;
    }

    public void setControlsShown(boolean shown) {
        FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) getLayoutParams();
        int b = ui.px(OverlayMetrics.cornerBottom(shown));
        if (p != null && p.bottomMargin != b) {
            p.bottomMargin = b;
            setLayoutParams(p);
        }
    }

    public void bind(@Nullable VideoRequest.Next next, boolean autoplay) {
        this.autoplay = autoplay;
        cancel.setVisibility(autoplay ? VISIBLE : GONE);
        countdown.setVisibility(autoplay ? VISIBLE : GONE);
        bar.setVisibility(autoplay ? VISIBLE : GONE);
        if (next == null) {
            images.into(thumb, null, 0, null);
            return;
        }
        title.setText(next.title);
        subtitle.setText(next.subtitle == null ? "" : next.subtitle);
        subtitle.setVisibility(next.subtitle == null ? GONE : VISIBLE);
        images.into(thumb, next.artworkUrl, ui.px(160), null);
    }

    /** The countdown: {@code leftMs} of {@code totalMs}; {@code running} false holds the bar (paused). */
    public void setCountdown(long leftMs, long totalMs, boolean running) {
        if (!autoplay) return;
        long s = Math.max(0, (long) Math.ceil(leftMs / 1000.0));
        countdown.setText(ui.strings.nextIn(s));
        bar.set(leftMs, totalMs, running && !ui.reduceMotion);
    }

    /** The 3 px bar along the bottom edge, shrinking towards the left as the countdown runs. */
    private final class DrainBar extends View {
        private final Paint paint = new Paint();
        private long leftMs;
        private long totalMs = 1;
        private long setAt;
        private boolean running;

        DrainBar(Context c) {
            super(c);
            paint.setColor(ui.theme.accent);
        }

        void set(long left, long total, boolean run) {
            leftMs = left;
            totalMs = Math.max(1, total);
            setAt = SystemClock.uptimeMillis();
            running = run;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            long left = leftMs;
            if (running) left -= SystemClock.uptimeMillis() - setAt;
            // Reduce motion: the bar does not move (full width), only the text counts.
            float f = ui.reduceMotion ? 1f : Math.max(0, Math.min(1f, left / (float) totalMs));
            c.drawRect(0, 0, getWidth() * f, getHeight(), paint);
            if (running && left > 0) postInvalidateOnAnimation();
        }
    }
}
