package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/**
 * The 52 px play / pause circle (primary colours): two 5x18 bars 5 apart while playing, an 18x20
 * triangle (3 px right of centre) while paused.
 */
@SuppressLint("ViewConstructor")
public final class PlayToggleView extends View {

    private final Ui ui;
    private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glyph = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF rect = new RectF();
    private boolean playing;

    public PlayToggleView(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        bg.setColor(ui.theme.primaryBg);
        glyph.setColor(ui.theme.primaryText);
        Ui.focusable(this, 26);
    }

    public void setPlaying(boolean playing) {
        if (this.playing == playing) return;
        this.playing = playing;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        c.drawCircle(cx, cy, Math.min(cx, cy), bg);
        if (playing) {
            float w = ui.pxf(5);
            float h = ui.pxf(18);
            float gap = ui.pxf(5);
            float r = ui.pxf(1);
            rect.set(cx - gap / 2 - w, cy - h / 2, cx - gap / 2, cy + h / 2);
            c.drawRoundRect(rect, r, r, glyph);
            rect.set(cx + gap / 2, cy - h / 2, cx + gap / 2 + w, cy + h / 2);
            c.drawRoundRect(rect, r, r, glyph);
        } else {
            // The template's path "M1 1l14 8-14 8z" in a 16x18 box drawn 18x20, margin-left 3.
            float bw = ui.pxf(18);
            float bh = ui.pxf(20);
            float left = cx - bw / 2 + ui.pxf(1.5f);
            float top = cy - bh / 2;
            float sx = bw / 16f;
            float sy = bh / 18f;
            path.reset();
            path.moveTo(left + sx, top + sy);
            path.lineTo(left + 15 * sx, top + 9 * sy);
            path.lineTo(left + sx, top + 17 * sy);
            path.close();
            c.drawPath(path, glyph);
        }
    }
}
