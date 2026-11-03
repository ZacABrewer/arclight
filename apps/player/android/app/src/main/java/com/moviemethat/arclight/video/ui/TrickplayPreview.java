package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.OverlayMetrics;
import com.moviemethat.arclight.video.TrickplayMath;
import com.moviemethat.arclight.video.VideoRequest;
import com.moviemethat.arclight.video.VideoTimeline;

/**
 * The scrub preview above the knob (§5.3): a 240x135 thumbnail (radius 8, 2 px text-colour
 * border) cut from the trickplay sheet, then the time (15/700) and the chapter title (13, text2).
 * Without trickplay (or before the sheet arrives with none decoded yet) only the texts show.
 */
@SuppressLint("ViewConstructor")
public final class TrickplayPreview extends LinearLayout implements SheetCache.Listener {

    private final Ui ui;
    private final SheetCache sheets;
    private final TileView tile;
    private final TextView time;
    private final TextView chapter;
    @Nullable private VideoRequest.Trickplay trickplay;
    private long shownMs = -1;

    public TrickplayPreview(Context context, Ui ui, SheetCache sheets) {
        super(context);
        this.ui = ui;
        this.sheets = sheets;
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_HORIZONTAL);
        tile = new TileView(context);
        addView(tile, ui.lin(ui.px(OverlayMetrics.PREVIEW_W), ui.px(OverlayMetrics.PREVIEW_H)));
        time = ui.text(15, 700, ui.theme.text);
        Ui.tabular(time);
        LayoutParams tp = ui.lin(Ui.WRAP, Ui.WRAP);
        tp.topMargin = ui.px(8);
        addView(time, tp);
        chapter = ui.line(13, 400, ui.theme.text2, 1);
        chapter.setMaxWidth(ui.px(OverlayMetrics.PREVIEW_W));
        LayoutParams cp = ui.lin(Ui.WRAP, Ui.WRAP);
        cp.topMargin = ui.px(4);
        addView(chapter, cp);
        sheets.setListener(this);
        setVisibility(GONE);
    }

    public void bind(@Nullable VideoRequest.Trickplay t) {
        trickplay = t;
        tile.bitmap = null;
        tile.setVisibility(t == null ? GONE : VISIBLE);
        shownMs = -1;
    }

    /** Shows the preview for {@code ms}. */
    public void show(long ms, @Nullable String chapterTitle) {
        shownMs = ms;
        time.setText(VideoTimeline.clock(ms));
        chapter.setText(chapterTitle == null ? "" : chapterTitle);
        chapter.setVisibility(chapterTitle == null ? GONE : VISIBLE);
        updateTile();
        setVisibility(VISIBLE);
    }

    public void hide() {
        shownMs = -1;
        setVisibility(GONE);
    }

    private void updateTile() {
        VideoRequest.Trickplay t = trickplay;
        if (t == null || shownMs < 0) return;
        TrickplayMath.Tile at = TrickplayMath.tileAt(t, shownMs);
        Bitmap b = sheets.get(at.sheet);
        tile.set(b, at, t);
    }

    @Override
    public void onSheetReady(int sheet) {
        if (getVisibility() == VISIBLE) updateTile();
    }

    /** Draws one tile of a sheet into the rounded, bordered box. */
    private final class TileView extends View {
        @Nullable Bitmap bitmap;
        private final Rect src = new Rect();
        private final RectF dst = new RectF();
        private final Path clip = new Path();
        private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint empty = new Paint();

        TileView(Context c) {
            super(c);
            border.setStyle(Paint.Style.STROKE);
            border.setColor(ui.theme.text);
            border.setStrokeWidth(ui.pxf(2));
            empty.setColor(ui.theme.bg);
        }

        void set(@Nullable Bitmap b, TrickplayMath.Tile at, VideoRequest.Trickplay t) {
            if (b == null) {
                // Keep the last tile until the new sheet arrives (no flashing while scrubbing).
                invalidate();
                return;
            }
            bitmap = b;
            // A sheet is columns*tileWidth x rows*tileHeight; scale if the server sent another size.
            float sx = b.getWidth() / (float) (t.columns * t.tileWidth);
            float sy = b.getHeight() / (float) (t.rows * t.tileHeight);
            src.set(Math.round(at.x * sx), Math.round(at.y * sy), Math.round((at.x + t.tileWidth) * sx),
                    Math.round((at.y + t.tileHeight) * sy));
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float bw = ui.pxf(2);
            float r = ui.pxf(8);
            dst.set(0, 0, getWidth(), getHeight());
            clip.reset();
            clip.addRoundRect(dst, r, r, Path.Direction.CW);
            c.save();
            c.clipPath(clip);
            c.drawRect(dst, empty);
            if (bitmap != null) c.drawBitmap(bitmap, src, dst, paint);
            c.restore();
            dst.inset(bw / 2, bw / 2);
            c.drawRoundRect(dst, r - bw / 2, r - bw / 2, border);
        }
    }
}
