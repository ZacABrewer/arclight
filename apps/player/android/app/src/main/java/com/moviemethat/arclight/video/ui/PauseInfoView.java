package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
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
 * The pause screen (§5.2): after 6 s paused with no input, the backdrop (or the dimmed current
 * frame) fades in over 0.6 s with a gradient from the background on the left; at left 56,
 * vertically centred, 600 wide: the logo (max 360x120) or the title 48/800, the episode line
 * 20/600, the meta line (boxed certification, chips, plain text, 14 apart, 15 px text2), the
 * overview 17 px in 4 lines and "Ends at 9:42 PM" 15 px text3.
 */
@SuppressLint("ViewConstructor")
public final class PauseInfoView extends FrameLayout {

    private final Ui ui;
    private final ImageLoader images;
    private final ImageView backdrop;
    private final View dim;
    private final ImageView logo;
    private final TextView title;
    private final TextView episodeLine;
    private final LinearLayout meta;
    private final TextView overview;
    private final TextView endsAt;
    private boolean showing;

    public PauseInfoView(Context context, Ui ui, ImageLoader images) {
        super(context);
        this.ui = ui;
        this.images = images;
        OverlayTheme t = ui.theme;

        backdrop = new ImageView(context);
        backdrop.setScaleType(ImageView.ScaleType.CENTER_CROP);
        addView(backdrop, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.CENTER));
        dim = new View(context);
        dim.setBackgroundColor(OverlayTheme.alpha(t.bg, 0.6f));
        addView(dim, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.CENTER));
        View grad = new View(context);
        grad.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[] {t.bg, OverlayTheme.alpha(t.bg, 0.75f), OverlayTheme.alpha(t.bg, 0f)}));
        addView(grad, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.CENTER));

        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        logo = new ImageView(context);
        logo.setAdjustViewBounds(true);
        logo.setMaxWidth(ui.px(360));
        logo.setMaxHeight(ui.px(120));
        logo.setScaleType(ImageView.ScaleType.FIT_START);
        logo.setVisibility(GONE);
        col.addView(logo, ui.lin(Ui.WRAP, Ui.WRAP));
        title = ui.line(48, 800, t.text, 2);
        col.addView(title, ui.lin(Ui.MATCH, Ui.WRAP));
        episodeLine = ui.line(20, 600, t.text, 1);
        col.addView(episodeLine, margin(ui.lin(Ui.MATCH, Ui.WRAP), 12));
        meta = new LinearLayout(context);
        meta.setOrientation(LinearLayout.HORIZONTAL);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        col.addView(meta, margin(ui.lin(Ui.MATCH, Ui.WRAP), 14));
        overview = ui.line(17, 400, t.text2, 4);
        overview.setLineSpacing(0, 1.4f);
        col.addView(overview, margin(ui.lin(Ui.MATCH, Ui.WRAP), 16));
        endsAt = ui.text(15, 400, t.text3);
        col.addView(endsAt, margin(ui.lin(Ui.MATCH, Ui.WRAP), 16));

        FrameLayout.LayoutParams cp = ui.frame(ui.px(600), Ui.WRAP, Gravity.CENTER_VERTICAL | Gravity.START);
        cp.leftMargin = ui.px(OverlayMetrics.SIDE);
        addView(col, cp);

        setVisibility(GONE);
        setClickable(false);
    }

    private LinearLayout.LayoutParams margin(LinearLayout.LayoutParams p, int top) {
        p.topMargin = ui.px(top);
        return p;
    }

    public void bind(VideoRequest.Pause p) {
        title.setText(p.title);
        title.setVisibility(VISIBLE);
        logo.setVisibility(GONE);
        images.into(logo, p.logoUrl, ui.px(360), bmp -> {
            boolean has = bmp != null;
            logo.setVisibility(has ? VISIBLE : GONE);
            title.setVisibility(has ? GONE : VISIBLE);
        });
        episodeLine.setText(p.episodeLine == null ? "" : p.episodeLine);
        episodeLine.setVisibility(p.episodeLine == null ? GONE : VISIBLE);
        meta.removeAllViews();
        for (VideoRequest.MetaPiece m : p.meta) {
            TextView v;
            if (m.boxed) {
                v = ui.text(12, 400, ui.theme.text2);
                v.setPadding(ui.px(6), ui.px(1), ui.px(6), ui.px(1));
                v.setBackground(ui.round(0, 4, ui.theme.certBorder, 1));
            } else if (m.chip) {
                v = ui.text(12, 700, ui.theme.text);
                v.setPadding(ui.px(6), ui.px(2), ui.px(6), ui.px(2));
                v.setBackground(ui.round(ui.theme.fill, 4));
            } else {
                v = ui.text(15, 400, ui.theme.text2);
            }
            v.setText(m.text);
            v.setSingleLine(true);
            LinearLayout.LayoutParams lp = ui.lin(Ui.WRAP, Ui.WRAP);
            if (meta.getChildCount() > 0) lp.leftMargin = ui.px(14);
            meta.addView(v, lp);
        }
        meta.setVisibility(p.meta.isEmpty() ? GONE : VISIBLE);
        overview.setText(p.overview == null ? "" : p.overview);
        overview.setVisibility(p.overview == null ? GONE : VISIBLE);
        backdrop.setVisibility(GONE);
        dim.setVisibility(VISIBLE);
        images.into(backdrop, p.backdropUrl, ui.px(OverlayMetrics.STAGE_W), bmp -> {
            boolean has = bmp != null;
            backdrop.setVisibility(has ? VISIBLE : GONE);
            // Without a backdrop the current frame shows through, dimmed.
            dim.setVisibility(has ? GONE : VISIBLE);
        });
    }

    public void setEndsAt(String text) {
        endsAt.setText(text);
    }

    public boolean isShowing() {
        return showing;
    }

    public void show() {
        if (showing) return;
        showing = true;
        animate().cancel();
        setAlpha(0f);
        setVisibility(VISIBLE);
        long d = ui.anim(600);
        if (d == 0) setAlpha(1f);
        else animate().alpha(1f).setDuration(d).start();
    }

    public void hide() {
        if (!showing) return;
        showing = false;
        animate().cancel();
        setVisibility(GONE);
    }
}
