package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import com.moviemethat.arclight.video.OverlayTheme;

/** The big centred pause mark while paused: a 96 px circle (bg at .55) with two 8x30 white bars, 8 apart. */
@SuppressLint("ViewConstructor")
public final class PauseGlyphView extends View {

    private final Ui ui;
    private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bar = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();

    public PauseGlyphView(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        bg.setColor(OverlayTheme.alpha(ui.theme.bg, 0.55f));
        bar.setColor(0xFFFFFFFF);
    }

    @Override
    protected void onDraw(Canvas c) {
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        c.drawCircle(cx, cy, Math.min(cx, cy), bg);
        float w = ui.pxf(8);
        float h = ui.pxf(30);
        float gap = ui.pxf(8);
        float r = ui.pxf(2);
        rect.set(cx - gap / 2 - w, cy - h / 2, cx - gap / 2, cy + h / 2);
        c.drawRoundRect(rect, r, r, bar);
        rect.set(cx + gap / 2, cy - h / 2, cx + gap / 2 + w, cy + h / 2);
        c.drawRoundRect(rect, r, r, bar);
    }
}
