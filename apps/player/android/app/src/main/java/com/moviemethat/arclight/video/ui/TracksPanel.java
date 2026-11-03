package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
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
 * subtitle row. Picks keep the panel open; focus starts on the selected audio row.
 */
@SuppressLint("ViewConstructor")
public final class TracksPanel extends SidePanel {

    public interface Listener {
        void onAudioPicked(int position);

        /** {@code position} 0 = Off, else subtitle {@code position - 1}. */
        void onSubtitlePicked(int position);
    }

    private final LinearLayout list;
    private final List<Row> audioRows = new ArrayList<>();
    private final List<Row> subRows = new ArrayList<>();
    @Nullable private Listener listener;

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

    /** Rebuilds the lists; {@code audioSelected} / {@code subSelected} are row positions (-1: none). */
    public void bind(List<String> audio, int audioSelected, List<String> subtitles, int subSelected) {
        list.removeAllViews();
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
                Row r = new Row(audio.get(i), () -> {
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
            Row r = new Row(subs.get(i), () -> {
                select(subRows, pos);
                if (listener != null) listener.onSubtitlePicked(pos);
            });
            subRows.add(r);
            list.addView(r.view, gapped(8, 0));
        }
        select(subRows, subSelected);
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

        Row(String label, Runnable onPick) {
            view = new LinearLayout(getContext());
            view.setOrientation(LinearLayout.HORIZONTAL);
            view.setGravity(Gravity.CENTER_VERTICAL);
            view.setPadding(ui.px(16), ui.px(11), ui.px(16), ui.px(11));
            Ui.focusable(view, 8);
            view.setOnClickListener(v -> onPick.run());
            name = ui.line(16, 600, ui.theme.text3, 1);
            name.setText(label);
            view.addView(name, new LinearLayout.LayoutParams(0, Ui.WRAP, 1f));
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
