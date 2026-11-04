package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.video.OverlayMetrics;
import com.moviemethat.arclight.video.PlayerChrome;
import com.moviemethat.arclight.video.VideoSeekBar;

/**
 * The playback controls (§5.1), laid out from the template's player screen in stage px:
 * <ul>
 *   <li>top: a 180 px gradient (black .7 to 0), the title 28/800 and the sub line 16 (text2) at
 *       left 56, top 40, 6 apart; at the right (top 44, 14 apart, 14 text3) the picture and
 *       audio badges (12/700 on white .14, radius 4), the delivery and the clock;</li>
 *   <li>bottom: a 260 px gradient (black .82 to 0) under a column at left / right 56, bottom 40,
 *       18 apart: the scrub bar with the time "m:ss / m:ss" (15, text2, tabular figures), then
 *       the row of play / pause, −10, +10, "Next episode", "Episodes", and "Audio &amp;
 *       Subtitles" at the right (12 apart).</li>
 * </ul>
 * The scrub preview ({@link TrickplayPreview}) floats above the knob. On a touch screen (a phone)
 * −10, play / pause and +10 sit in the middle of the picture instead, bigger and easy to reach.
 */
@SuppressLint("ViewConstructor")
public final class ControlsView extends FrameLayout {

    public final TextView title;
    public final TextView subtitle;
    /** Top right: the badges, the delivery, "·" and the clock. */
    private final LinearLayout info;
    private final TextView clock;
    public final VideoSeekBar bar;
    public final TextView time;
    public final PlayToggleView toggle;
    public final TextView back10;
    public final TextView fwd10;
    public final TextView next;
    public final TextView episodes;
    public final TextView tracks;
    public final TrickplayPreview preview;
    /** The two bottom rows, for row-constrained Left / Right. */
    public final LinearLayout barRow;
    public final LinearLayout buttonRow;
    private final Ui ui;

    /** Phone layout: the play / pause, −10 and +10 in the middle of the picture. */
    public static final int CENTER_TOGGLE = 104;
    public static final int CENTER_SKIP = 72;

    public ControlsView(Context context, Ui ui, SheetCache sheets, boolean touch) {
        super(context);
        this.ui = ui;
        setClipChildren(false);

        View top = new View(context);
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] {0xB3000000, 0x00000000}));
        addView(top, ui.frame(Ui.MATCH, ui.px(180), Gravity.TOP));
        View bottom = new View(context);
        bottom.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[] {0xD1000000, 0x00000000}));
        addView(bottom, ui.frame(Ui.MATCH, ui.px(260), Gravity.BOTTOM));

        LinearLayout titles = new LinearLayout(context);
        titles.setOrientation(LinearLayout.VERTICAL);
        title = ui.line(28, 800, ui.theme.text, 1);
        titles.addView(title, ui.lin(Ui.WRAP, Ui.WRAP));
        subtitle = ui.line(16, 400, ui.theme.text2, 1);
        LinearLayout.LayoutParams sp = ui.lin(Ui.WRAP, Ui.WRAP);
        sp.topMargin = ui.px(6);
        titles.addView(subtitle, sp);
        FrameLayout.LayoutParams tp = ui.frame(Ui.MATCH, Ui.WRAP, Gravity.TOP | Gravity.START);
        tp.leftMargin = ui.px(OverlayMetrics.SIDE);
        // Clear of the top-right line (badges, delivery, clock): a long title ends in "…" first.
        tp.rightMargin = ui.px(OverlayMetrics.SIDE + 380);
        tp.topMargin = ui.px(40);
        addView(titles, tp);

        info = new LinearLayout(context);
        info.setOrientation(LinearLayout.HORIZONTAL);
        info.setGravity(Gravity.CENTER_VERTICAL);
        clock = ui.text(14, 400, ui.theme.text3);
        Ui.tabular(clock);
        clock.setSingleLine(true);
        FrameLayout.LayoutParams ip = ui.frame(Ui.WRAP, ui.px(24), Gravity.TOP | Gravity.END);
        ip.rightMargin = ui.px(OverlayMetrics.SIDE);
        ip.topMargin = ui.px(44);
        addView(info, ip);
        setInfo(null);

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setClipChildren(false);

        barRow = new LinearLayout(context);
        barRow.setOrientation(LinearLayout.HORIZONTAL);
        barRow.setGravity(Gravity.CENTER_VERTICAL);
        barRow.setClipChildren(false);
        bar = new VideoSeekBar(context, ui);
        barRow.addView(bar, new LinearLayout.LayoutParams(0, ui.px(24), 1f));
        time = ui.text(15, 400, ui.theme.text2);
        Ui.tabular(time);
        time.setSingleLine(true);
        LinearLayout.LayoutParams timeLp = ui.lin(Ui.WRAP, Ui.WRAP);
        timeLp.leftMargin = ui.px(18);
        barRow.addView(time, timeLp);
        column.addView(barRow, ui.lin(Ui.MATCH, Ui.WRAP));

        buttonRow = new LinearLayout(context);
        buttonRow.setOrientation(LinearLayout.HORIZONTAL);
        buttonRow.setGravity(Gravity.CENTER_VERTICAL);
        buttonRow.setClipChildren(false);
        int b = ui.px(52);
        toggle = new PlayToggleView(context, ui);
        toggle.setContentDescription(context.getString(R.string.video_play));
        back10 = ui.circle(context.getString(R.string.video_minus_10));
        back10.setContentDescription(context.getString(R.string.video_back_10));
        fwd10 = ui.circle(context.getString(R.string.video_plus_10));
        fwd10.setContentDescription(context.getString(R.string.video_forward_10));
        if (touch) {
            LinearLayout center = new LinearLayout(context);
            center.setOrientation(LinearLayout.HORIZONTAL);
            center.setGravity(Gravity.CENTER);
            center.setClipChildren(false);
            int s = ui.px(CENTER_SKIP);
            for (TextView v : new TextView[] {back10, fwd10}) v.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, ui.pxf(20));
            center.addView(back10, ui.lin(s, s));
            LinearLayout.LayoutParams tl = ui.lin(ui.px(CENTER_TOGGLE), ui.px(CENTER_TOGGLE));
            tl.leftMargin = ui.px(56);
            tl.rightMargin = ui.px(56);
            center.addView(toggle, tl);
            center.addView(fwd10, ui.lin(s, s));
            addView(center, ui.frame(Ui.WRAP, Ui.WRAP, Gravity.CENTER));
        } else {
            buttonRow.addView(toggle, ui.lin(b, b));
            buttonRow.addView(back10, gap(ui.lin(b, b)));
            buttonRow.addView(fwd10, gap(ui.lin(b, b)));
        }
        next = ui.pill(ui.strings.get("nextEpisode"));
        buttonRow.addView(next, buttonRow.getChildCount() == 0 ? ui.lin(Ui.WRAP, b) : gap(ui.lin(Ui.WRAP, b)));
        episodes = ui.pill(ui.strings.get("episodes"));
        buttonRow.addView(episodes, gap(ui.lin(Ui.WRAP, b)));
        View spacer = new View(context);
        buttonRow.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));
        tracks = ui.pill(ui.strings.get("audioSubtitles"));
        buttonRow.addView(tracks, gap(ui.lin(Ui.WRAP, b)));
        LinearLayout.LayoutParams rp = ui.lin(Ui.MATCH, Ui.WRAP);
        rp.topMargin = ui.px(18);
        column.addView(buttonRow, rp);

        FrameLayout.LayoutParams cp = ui.frame(Ui.MATCH, Ui.WRAP, Gravity.BOTTOM);
        cp.leftMargin = ui.px(OverlayMetrics.SIDE);
        cp.rightMargin = ui.px(OverlayMetrics.SIDE);
        cp.bottomMargin = ui.px(40);
        addView(column, cp);

        preview = new TrickplayPreview(context, ui, sheets);
        FrameLayout.LayoutParams pp = ui.frame(Ui.WRAP, Ui.WRAP, Gravity.BOTTOM | Gravity.START);
        // Above the bar: bottom 40 + the 52 button row + 18 + the 24 bar, then 12 clear of it.
        pp.bottomMargin = ui.px(40 + 52 + 18 + 24 + 12);
        addView(preview, pp);
    }

    private LinearLayout.LayoutParams gap(LinearLayout.LayoutParams p) {
        p.leftMargin = ui.px(12);
        return p;
    }

    public void setTitles(String t, @Nullable String sub) {
        title.setText(t);
        subtitle.setText(sub == null ? "" : sub);
        subtitle.setVisibility(sub == null || sub.isEmpty() ? GONE : VISIBLE);
    }

    /** The top-right line; null: the clock alone. */
    public void setInfo(@Nullable PlayerChrome.Info i) {
        info.removeAllViews();
        if (i != null) {
            for (String b : i.badges) {
                TextView v = ui.text(12, 700, ui.theme.text);
                v.setText(b);
                v.setSingleLine(true);
                v.setPadding(ui.px(6), ui.px(2), ui.px(6), ui.px(2));
                v.setBackground(ui.round(ui.theme.fill, 4));
                info.addView(v, infoGap(ui.lin(Ui.WRAP, Ui.WRAP)));
            }
            if (i.method != null) {
                info.addView(infoText(i.method), infoGap(ui.lin(Ui.WRAP, Ui.WRAP)));
                info.addView(infoText("·"), infoGap(ui.lin(Ui.WRAP, Ui.WRAP)));
            }
        }
        if (clock.getParent() != null) ((android.view.ViewGroup) clock.getParent()).removeView(clock);
        info.addView(clock, infoGap(ui.lin(Ui.WRAP, Ui.WRAP)));
    }

    private TextView infoText(String t) {
        TextView v = ui.text(14, 400, ui.theme.text3);
        v.setText(t);
        v.setSingleLine(true);
        return v;
    }

    private LinearLayout.LayoutParams infoGap(LinearLayout.LayoutParams p) {
        if (info.getChildCount() > 0) p.leftMargin = ui.px(14);
        return p;
    }

    /** "9:41 PM" (the system's 12 / 24 hour format). */
    public void setClock(String time) {
        if (!time.contentEquals(clock.getText())) clock.setText(time);
    }

    /** Places the preview centred over the bar's knob for {@code ms}, inside the 56 px margins. */
    public void placePreview(long ms) {
        android.graphics.Rect r = new android.graphics.Rect(0, 0, bar.getWidth(), bar.getHeight());
        offsetDescendantRectToMyCoords(bar, r);
        float knob = r.left + bar.knobX(ms);
        preview.measure(MeasureSpec.makeMeasureSpec(getWidth(), MeasureSpec.AT_MOST),
                MeasureSpec.makeMeasureSpec(getHeight(), MeasureSpec.AT_MOST));
        float w = preview.getMeasuredWidth();
        float left = OverlayMetrics.previewLeft(knob / ui.k, w / ui.k, getWidth() / ui.k) * ui.k;
        preview.setTranslationX(left);
    }
}
