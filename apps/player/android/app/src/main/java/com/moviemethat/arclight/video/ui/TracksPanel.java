package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.List;

/**
 * The Audio &amp; Subtitles panel (§5.7), as in the template: 440 wide, padding 52 40, the heading
 * 24/700, the AUDIO and SUBTITLES labels (13/700, .12em, text4) and rows (padding 11 16, radius 8,
 * 16/600; the selected one in white with an accent ✓, the others text3). "Off" is the first
 * subtitle row. An audio track this TV cannot decode in direct play carries a note (12/500,
 * #ffb86b). The focused row gets white .08 under the ring. "Subtitle size" sits at the bottom
 * (its value in accent, OK steps Small → Medium → Large). Picks keep the panel open; focus starts
 * on the selected audio row.
 */
@SuppressLint("ViewConstructor")
public final class TracksPanel extends SidePanel {

    public interface Listener {
        void onAudioPicked(int position);

        /** {@code position} 0 = Off, else subtitle {@code position - 1}. */
        void onSubtitlePicked(int position);

        /** 'small' | 'medium' | 'large'. */
        void onSubtitleSizePicked(String size);
    }

    public static final int NOTE = 0xFFFFB86B;
    private static final String[] SIZES = {"small", "medium", "large"};

    private final LinearLayout list;
    private final List<Row> audioRows = new ArrayList<>();
    private final List<Row> subRows = new ArrayList<>();
    @Nullable private Listener listener;
    private String size = "medium";
    @Nullable private Row sizeRow;

    public TracksPanel(Context context, Ui ui) {
        super(context, ui, 440);
        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        scroll.setFillViewport(true);
        list = new LinearLayout(context);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(ui.px(40), ui.px(52), ui.px(40), ui.px(52));
        scroll.addView(list, new ScrollView.LayoutParams(Ui.MATCH, Ui.WRAP));
        addView(scroll, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.TOP));
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    /**
     * Rebuilds the lists; {@code audioSelected} / {@code subSelected} are row positions (-1: none),
     * {@code audioNotes} the note under each audio row (null entries or list: none).
     */
    public void bind(List<String> audio, @Nullable List<String> audioNotes, int audioSelected, List<String> subtitles,
            int subSelected, String subtitleSize) {
        list.removeAllViews();
        size = subtitleSize;
        audioRows.clear();
        subRows.clear();
        TextView heading = ui.text(24, 700, ui.theme.text);
        heading.setText(ui.strings.get("audioSubtitles"));
        list.addView(heading, ui.lin(Ui.MATCH, Ui.WRAP));
        // The template's column gap is 8; the heading adds 12 below it.
        if (!audio.isEmpty()) {
            list.addView(label(ui.strings.get("audio")), gapped(20, 2));
            for (int i = 0; i < audio.size(); i++) {
                final int pos = i;
                String note = audioNotes != null && i < audioNotes.size() ? audioNotes.get(i) : null;
                Row r = new Row(audio.get(i), note, () -> {
                    select(audioRows, pos);
                    if (listener != null) listener.onAudioPicked(pos);
                });
                audioRows.add(r);
                list.addView(r.view, gapped(8, 0));
            }
            select(audioRows, audioSelected);
        }
        list.addView(label(ui.strings.get("subtitles")), gapped(audio.isEmpty() ? 20 : 8 + 14, 2));
        List<String> subs = new ArrayList<>();
        subs.add(ui.strings.get("off"));
        subs.addAll(subtitles);
        for (int i = 0; i < subs.size(); i++) {
            final int pos = i;
            Row r = new Row(subs.get(i), null, () -> {
                select(subRows, pos);
                if (listener != null) listener.onSubtitlePicked(pos);
            });
            subRows.add(r);
            list.addView(r.view, gapped(8, 0));
        }
        select(subRows, subSelected);
        // margin-top: auto: the size row sits at the bottom when the lists are short.
        list.addView(new View(getContext()), new LinearLayout.LayoutParams(Ui.MATCH, 0, 1f));
        Row sr = new Row(ui.strings.get("subtitleSize"), null, this::nextSize);
        sr.name.setTextColor(ui.theme.text2);
        sr.check.setVisibility(View.VISIBLE);
        sizeRow = sr;
        showSize();
        list.addView(sr.view, gapped(22, 0));
    }

    private void nextSize() {
        int i = 0;
        while (i < SIZES.length && !SIZES[i].equals(size)) i++;
        size = SIZES[(i + 1) % SIZES.length];
        showSize();
        if (listener != null) listener.onSubtitleSizePicked(size);
    }

    private void showSize() {
        Row r = sizeRow;
        if (r == null) return;
        String key = size.equals("small") ? "sizeSmall" : size.equals("large") ? "sizeLarge" : "sizeMedium";
        r.check.setText(ui.strings.get(key) + " ›");
    }

    private LinearLayout.LayoutParams gapped(int top, int bottomExtra) {
        LinearLayout.LayoutParams p = ui.lin(Ui.MATCH, Ui.WRAP);
        p.topMargin = ui.px(top);
        p.bottomMargin = ui.px(bottomExtra);
        return p;
    }

    private TextView label(String text) {
        TextView v = ui.text(13, 700, ui.theme.text4);
        Ui.tracking(v, 0.12f);
        v.setAllCaps(true);
        v.setText(text);
        return v;
    }

    private static void select(List<Row> rows, int pos) {
        for (int i = 0; i < rows.size(); i++) rows.get(i).setSelected(i == pos);
    }

    @Nullable
    @Override
    protected View initialFocus() {
        for (Row r : audioRows) if (r.selected) return r.view;
        if (!audioRows.isEmpty()) return audioRows.get(0).view;
        for (Row r : subRows) if (r.selected) return r.view;
        return subRows.isEmpty() ? null : subRows.get(0).view;
    }

    private final class Row {
        final LinearLayout view;
        final TextView name;
        final TextView check;
        boolean selected;

        Row(String label, @Nullable String note, Runnable onPick) {
            view = new LinearLayout(getContext());
            view.setOrientation(LinearLayout.HORIZONTAL);
            view.setGravity(Gravity.CENTER_VERTICAL);
            view.setPadding(ui.px(16), ui.px(11), ui.px(16), ui.px(11));
            StateListDrawable bg = new StateListDrawable();
            bg.addState(new int[] {android.R.attr.state_focused}, ui.round(ui.theme.chip, 8));
            view.setBackground(bg);
            Ui.focusable(view, 8);
            view.setOnClickListener(v -> onPick.run());
            LinearLayout texts = new LinearLayout(getContext());
            texts.setOrientation(LinearLayout.VERTICAL);
            name = ui.line(16, 600, ui.theme.text3, 1);
            name.setText(label);
            texts.addView(name, ui.lin(Ui.MATCH, Ui.WRAP));
            if (note != null && !note.isEmpty()) {
                TextView n = ui.line(12, 500, NOTE, 2);
                n.setText(note);
                LinearLayout.LayoutParams np = ui.lin(Ui.MATCH, Ui.WRAP);
                np.topMargin = ui.px(2);
                texts.addView(n, np);
            }
            view.addView(texts, new LinearLayout.LayoutParams(0, Ui.WRAP, 1f));
            check = ui.text(16, 600, ui.theme.accent);
            check.setText("✓");
            view.addView(check, ui.lin(Ui.WRAP, Ui.WRAP));
        }

        void setSelected(boolean s) {
            selected = s;
            name.setTextColor(s ? 0xFFFFFFFF : ui.theme.text3);
            check.setVisibility(s ? View.VISIBLE : View.INVISIBLE);
        }
    }
}
