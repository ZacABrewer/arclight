package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.FocusFinder;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.OverlayMetrics;
import com.moviemethat.arclight.video.OverlayTheme;
import java.util.ArrayList;
import java.util.List;

/**
 * A centred prompt over the dimmed picture, from the template's S18 (can't play) and S19 (are
 * you still watching?): optionally the title and sub line top-left as on the controls; optionally
 * the 64 px "!" disc (#ff8a80 on its .14); the heading (34 or 30 / 800, −.01em); the body (17,
 * text2, 1.5 line height, at most 640 wide); a detail line (13, text4, tabular figures); and a row
 * of 50 px buttons 12 apart, the first one primary. The focus stays on its buttons.
 */
@SuppressLint("ViewConstructor")
public final class PromptView extends FrameLayout {

    public interface Listener {
        void onPromptButton(int index);
    }

    public static final int DANGER = 0xFFFF8A80;

    private final Ui ui;
    private final LinearLayout titles;
    private final TextView title;
    private final TextView subtitle;
    private final TextView icon;
    private final TextView heading;
    private final TextView body;
    private final TextView detail;
    private final LinearLayout buttons;
    private final List<TextView> buttonViews = new ArrayList<>();
    @Nullable private Listener listener;

    public PromptView(Context context, Ui ui) {
        super(context);
        this.ui = ui;
        setClickable(true);
        setClipChildren(false);

        View top = new View(context);
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] {0x80000000, 0x00000000}));
        titles = new LinearLayout(context);
        titles.setOrientation(LinearLayout.VERTICAL);
        title = ui.line(28, 800, ui.theme.text, 1);
        titles.addView(title, ui.lin(Ui.WRAP, Ui.WRAP));
        subtitle = ui.line(16, 400, ui.theme.text2, 1);
        LinearLayout.LayoutParams sp = ui.lin(Ui.WRAP, Ui.WRAP);
        sp.topMargin = ui.px(6);
        titles.addView(subtitle, sp);
        FrameLayout.LayoutParams tp = ui.frame(Ui.MATCH, Ui.WRAP, Gravity.TOP | Gravity.START);
        tp.leftMargin = ui.px(OverlayMetrics.SIDE);
        tp.rightMargin = ui.px(OverlayMetrics.SIDE);
        tp.topMargin = ui.px(40);
        addView(top, ui.frame(Ui.MATCH, ui.px(120), Gravity.TOP));
        addView(titles, tp);
        titles.setTag(top);

        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setClipChildren(false);

        icon = ui.text(30, 800, DANGER);
        icon.setText("!");
        icon.setGravity(Gravity.CENTER);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(OverlayTheme.alpha(DANGER, 0.14f));
        icon.setBackground(disc);
        LinearLayout.LayoutParams ip = ui.lin(ui.px(64), ui.px(64));
        ip.bottomMargin = ui.px(22);
        col.addView(icon, ip);

        heading = ui.text(34, 800, ui.theme.text);
        Ui.tracking(heading, -0.01f);
        heading.setGravity(Gravity.CENTER);
        col.addView(heading, ui.lin(Ui.WRAP, Ui.WRAP));

        body = ui.text(17, 400, ui.theme.text2);
        body.setGravity(Gravity.CENTER);
        body.setLineSpacing(0, 1.5f);
        body.setMaxWidth(ui.px(640));
        col.addView(body, gap(ui.lin(Ui.WRAP, Ui.WRAP), 16));

        detail = ui.text(13, 400, ui.theme.text4);
        Ui.tabular(detail);
        detail.setGravity(Gravity.CENTER);
        col.addView(detail, gap(ui.lin(Ui.WRAP, Ui.WRAP), 16));

        buttons = new LinearLayout(context);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setClipChildren(false);
        col.addView(buttons, gap(ui.lin(Ui.WRAP, Ui.WRAP), 28));

        addView(col, ui.frame(Ui.WRAP, Ui.WRAP, Gravity.CENTER));
        setVisibility(GONE);
    }

    private LinearLayout.LayoutParams gap(LinearLayout.LayoutParams p, int top) {
        p.topMargin = ui.px(top);
        return p;
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    /**
     * Fills the prompt. {@code headerTitle} null: no title top-left. {@code dim}: the picture's
     * dim (0..1, the theme's background at that alpha).
     */
    public void bind(float dim, @Nullable String headerTitle, @Nullable String headerSub, boolean danger, float headingSize,
            String headingText, @Nullable String bodyText, @Nullable String detailText, List<String> labels) {
        setBackgroundColor(OverlayTheme.alpha(ui.theme.bg, dim));
        int head = headerTitle == null ? GONE : VISIBLE;
        titles.setVisibility(head);
        ((View) titles.getTag()).setVisibility(head);
        title.setText(headerTitle == null ? "" : headerTitle);
        subtitle.setText(headerSub == null ? "" : headerSub);
        subtitle.setVisibility(headerSub == null || headerSub.isEmpty() ? GONE : VISIBLE);
        icon.setVisibility(danger ? VISIBLE : GONE);
        heading.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, ui.pxf(headingSize));
        heading.setText(headingText);
        body.setText(bodyText == null ? "" : bodyText);
        body.setVisibility(bodyText == null || bodyText.isEmpty() ? GONE : VISIBLE);
        detail.setText(detailText == null ? "" : detailText);
        detail.setVisibility(detailText == null || detailText.isEmpty() ? GONE : VISIBLE);
        buttons.removeAllViews();
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttonViews.clear();
        for (int i = 0; i < labels.size(); i++) {
            final int index = i;
            TextView b = button(labels.get(i), i == 0);
            b.setOnClickListener(v -> {
                if (listener != null) listener.onPromptButton(index);
            });
            LinearLayout.LayoutParams lp = ui.lin(Ui.WRAP, ui.px(50));
            if (i > 0) lp.leftMargin = ui.px(12);
            buttons.addView(b, lp);
            buttonViews.add(b);
        }
    }

    private TextView button(String text, boolean primary) {
        TextView v = ui.text(17, 700, primary ? ui.theme.primaryText : ui.theme.text);
        v.setText(text);
        v.setGravity(Gravity.CENTER);
        // One line without setSingleLine: its horizontal scrolling clips the last glyph's overhang.
        v.setMaxLines(1);
        v.setPadding(ui.px(primary ? 26 : 24), 0, ui.px(primary ? 26 : 24), 0);
        v.setBackground(ui.round(primary ? ui.theme.primaryBg : ui.theme.fill, ui.theme.radiusButton));
        Ui.focusable(v, ui.theme.radiusButton);
        return v;
    }

    /** A narrow window (a phone held upright): the buttons stack when they don't fit side by side. */
    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int avail = MeasureSpec.getSize(widthMeasureSpec) - getPaddingLeft() - getPaddingRight() - ui.px(48);
        int unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED);
        int row = 0;
        int widest = 0;
        for (int i = 0; i < buttonViews.size(); i++) {
            TextView b = buttonViews.get(i);
            b.measure(unspecified, MeasureSpec.makeMeasureSpec(ui.px(50), MeasureSpec.EXACTLY));
            row += b.getMeasuredWidth() + (i > 0 ? ui.px(12) : 0);
            widest = Math.max(widest, b.getMeasuredWidth());
        }
        boolean stack = MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && row > avail;
        int orientation = stack ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL;
        if (buttons.getOrientation() != orientation) {
            buttons.setOrientation(orientation);
            buttons.setGravity(Gravity.CENTER_HORIZONTAL);
            for (int i = 0; i < buttonViews.size(); i++) {
                LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) buttonViews.get(i).getLayoutParams();
                lp.width = stack ? widest : Ui.WRAP;
                lp.leftMargin = stack || i == 0 ? 0 : ui.px(12);
                lp.topMargin = stack && i > 0 ? ui.px(12) : 0;
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
    }

    public boolean isShowing() {
        return getVisibility() == VISIBLE;
    }

    public void show() {
        setVisibility(VISIBLE);
        if (!buttonViews.isEmpty()) buttonViews.get(0).requestFocus();
    }

    public void hide() {
        setVisibility(GONE);
    }

    /** D-pad: along the buttons, trapped inside the prompt. True when it was a direction key. */
    public boolean moveFocus(int keyCode) {
        int dir;
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) dir = View.FOCUS_LEFT;
        else if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) dir = View.FOCUS_RIGHT;
        else if (keyCode == KeyEvent.KEYCODE_DPAD_UP) dir = View.FOCUS_UP;
        else if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) dir = View.FOCUS_DOWN;
        else return false;
        View focused = findFocus();
        if (focused == null) {
            if (!buttonViews.isEmpty()) buttonViews.get(0).requestFocus();
            return true;
        }
        View next = FocusFinder.getInstance().findNextFocus(buttons, focused, dir);
        if (next != null) next.requestFocus(dir);
        return true;
    }
}
