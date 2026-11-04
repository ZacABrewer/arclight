package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.moviemethat.arclight.video.OverlayTheme;
import java.util.Locale;

/**
 * Buffering (the template's S17): the picture dimmed (black .35), a 72 px ring (4 px, text at .18,
 * an accent quarter turning once every 0.9 s; standing still with reduce motion) over "Buffering ·
 * 2.4 MB/s" (16, text2, tabular figures; the rate only once one was measured). It takes no input.
 */
@SuppressLint("ViewConstructor")
public final class BufferingView extends FrameLayout {

    private final Ui ui;
    private final TextView label;
    private long kbps = -1;

    public BufferingView(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        setBackgroundColor(0x59000000);
        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.addView(new Ring(context), ui.lin(ui.px(72), ui.px(72)));
        label = ui.text(16, 400, ui.theme.text2);
        Ui.tabular(label);
        label.setSingleLine(true);
        LinearLayout.LayoutParams lp = ui.lin(Ui.WRAP, Ui.WRAP);
        lp.topMargin = ui.px(22);
        col.addView(label, lp);
        addView(col, ui.frame(Ui.WRAP, Ui.WRAP, Gravity.CENTER));
        setRate(0);
        setVisibility(GONE);
    }

    /** The measured throughput in kbit/s (0: none yet), shown in MB/s. */
    public void setRate(long kbitPerS) {
        if (kbitPerS == kbps) return;
        kbps = kbitPerS;
        String base = ui.strings.get("buffering");
        label.setText(kbitPerS > 0 ? base + " · " + String.format(Locale.getDefault(), "%.1f MB/s", kbitPerS / 8000f) : base);
    }

    public boolean isShowing() {
        return getVisibility() == VISIBLE;
    }

    private final class Ring extends View {
        private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint arc = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();

        Ring(Context c) {
            super(c);
            float w = ui.pxf(4);
            track.setStyle(Paint.Style.STROKE);
            track.setStrokeWidth(w);
            track.setColor(OverlayTheme.alpha(ui.theme.text, 0.18f));
            arc.setStyle(Paint.Style.STROKE);
            arc.setStrokeWidth(w);
            arc.setColor(ui.theme.accent);
        }

        @Override
        protected void onDraw(Canvas c) {
            float half = track.getStrokeWidth() / 2f;
            box.set(half, half, getWidth() - half, getHeight() - half);
            c.drawOval(box, track);
            float turn = ui.reduceMotion ? 0f : (SystemClock.uptimeMillis() % 900) / 900f * 360f;
            // border-top-color on a round box: a quarter centred on the top.
            c.drawArc(box, -135f + turn, 90f, false, arc);
            if (!ui.reduceMotion && isShown()) postInvalidateOnAnimation();
        }
    }
}
