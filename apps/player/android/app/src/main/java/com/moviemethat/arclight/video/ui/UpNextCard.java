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
import com.moviemethat.arclight.video.OverlayTheme;
import com.moviemethat.arclight.video.VideoRequest;

/**
 * The up-next card (§5.5, the template's S19): bottom-right where Skip sits, 560 wide, padding
 * 14, radius 12, the background at .92 with a 1 px border (white .12). A 180x101 thumbnail with a
 * 3 px accent bar draining along its bottom; "UP NEXT IN 12" (13/700, accent, .1em); the title
 * (18/700, one line) and the sub line (13, text3), 6 apart; "Play now" (primary, 40 tall) and
 * "Watch credits". Without autoplay: "UP NEXT" and "Play now" only, no bar. With reduce motion
 * the bar stands still (the label still counts).
 */
@SuppressLint("ViewConstructor")
public final class UpNextCard extends FrameLayout {

    private final Ui ui;
    private final ImageLoader images;
    private final ImageView thumb;
    private final TextView title;
    private final TextView subtitle;
    private final TextView label;
    public final TextView playNow;
    public final TextView cancel;
    private final DrainBar bar;
    private boolean autoplay = true;

    public UpNextCard(Context context, Ui ui, ImageLoader images) {
        super(context);
        this.ui = ui;
        this.images = images;
        setBackground(ui.round(OverlayTheme.alpha(ui.theme.bg, 0.92f), 12, 0x1FFFFFFF, 1));
        setClickable(true);
        setClipChildren(false);

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(ui.px(14), ui.px(14), ui.px(14), ui.px(14));
        row.setClipChildren(false);
        FrameLayout art = new FrameLayout(context);
        art.setBackground(ui.round(ui.theme.fill, ui.theme.radiusTile));
        art.setClipToOutline(true);
        thumb = new ImageView(context);
        thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        art.addView(thumb, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.TOP));
        bar = new DrainBar(context);
        art.addView(bar, ui.frame(Ui.MATCH, ui.px(3), Gravity.BOTTOM));
        row.addView(art, ui.lin(ui.px(180), ui.px(101)));

        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setClipChildren(false);
        label = ui.text(13, 700, ui.theme.accent);
        Ui.tracking(label, 0.1f);
        label.setAllCaps(true);
        Ui.tabular(label);
        label.setText(ui.strings.get("upNext"));
        col.addView(label, ui.lin(Ui.WRAP, Ui.WRAP));
        title = ui.line(18, 700, ui.theme.text, 1);
        col.addView(title, top(ui.lin(Ui.MATCH, Ui.WRAP), 6));
        subtitle = ui.line(13, 400, ui.theme.text3, 1);
        col.addView(subtitle, top(ui.lin(Ui.MATCH, Ui.WRAP), 6));

        LinearLayout buttons = new LinearLayout(context);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER_VERTICAL);
        buttons.setClipChildren(false);
        playNow = button(ui.strings.get("playNow"), true);
        buttons.addView(playNow, ui.lin(Ui.WRAP, ui.px(40)));
        cancel = button(ui.strings.get("watchCredits"), false);
        LinearLayout.LayoutParams cl = ui.lin(Ui.WRAP, ui.px(40));
        cl.leftMargin = ui.px(10);
        buttons.addView(cancel, cl);
        col.addView(buttons, top(ui.lin(Ui.WRAP, Ui.WRAP), 10));

        LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(0, Ui.WRAP, 1f);
        colLp.leftMargin = ui.px(16);
        row.addView(col, colLp);
        addView(row, ui.frame(Ui.MATCH, Ui.WRAP, Gravity.TOP));
        setVisibility(GONE);
    }

    private LinearLayout.LayoutParams top(LinearLayout.LayoutParams p, int m) {
        p.topMargin = ui.px(m);
        return p;
    }

    private TextView button(String text, boolean primary) {
        TextView v = ui.text(15, primary ? 700 : 600, primary ? ui.theme.primaryText : ui.theme.text);
        v.setText(text);
        v.setGravity(Gravity.CENTER);
        v.setSingleLine(true);
        v.setPadding(ui.px(primary ? 18 : 16), 0, ui.px(primary ? 18 : 16), 0);
        v.setBackground(ui.round(primary ? ui.theme.primaryBg : ui.theme.fill, ui.theme.radiusButton));
        Ui.focusable(v, ui.theme.radiusButton);
        return v;
    }

    public FrameLayout.LayoutParams params() {
        FrameLayout.LayoutParams p = ui.frame(ui.px(560), Ui.WRAP, Gravity.BOTTOM | Gravity.END);
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
        bar.setVisibility(autoplay ? VISIBLE : GONE);
        label.setText(ui.strings.get("upNext"));
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
        label.setText(ui.strings.upNextIn(s));
        bar.set(leftMs, totalMs, running && !ui.reduceMotion);
    }

    /** The 3 px bar along the thumbnail's bottom, shrinking towards the left as the countdown runs. */
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
