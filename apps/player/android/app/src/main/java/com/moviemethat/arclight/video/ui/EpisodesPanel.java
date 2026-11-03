package com.moviemethat.arclight.video.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.OverlayStrings;
import com.moviemethat.arclight.video.VideoRequest;
import java.util.ArrayList;
import java.util.List;

/**
 * The Episodes panel (§5.4): 520 wide on the right, the heading "Episodes" 24/700, season chips
 * (pill, padding 7 16, 14/600; the selected one inverted), then the season's episodes: a 160x90
 * thumbnail with a 3 px progress bar, "E5 · Title" 15/700, the runtime 13 text3 with an accent
 * "Now playing" for the current one, and two lines of overview. Picking an episode calls the
 * listener; focus starts on the current episode.
 */
@SuppressLint("ViewConstructor")
public final class EpisodesPanel extends SidePanel {

    public interface Listener {
        void onEpisodePicked(VideoRequest.Episode episode);
    }

    private final ImageLoader images;
    private final LinearLayout chips;
    private final HorizontalScrollView chipScroll;
    private final LinearLayout rows;
    private final ScrollView rowScroll;
    private final List<TextView> chipViews = new ArrayList<>();
    private List<VideoRequest.Season> seasons = new ArrayList<>();
    private String currentKey = "";
    private int shownSeason = -1;
    @Nullable private View currentRow;
    @Nullable private Listener listener;

    public EpisodesPanel(Context context, Ui ui, ImageLoader images) {
        super(context, ui, 520);
        this.images = images;
        LinearLayout col = new LinearLayout(context);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(ui.px(40), ui.px(52), ui.px(40), 0);
        col.setClipChildren(false);
        col.setClipToPadding(false);

        TextView heading = ui.text(24, 700, ui.theme.text);
        heading.setText(ui.strings.get("episodes"));
        col.addView(heading, ui.lin(Ui.MATCH, Ui.WRAP));

        chipScroll = new HorizontalScrollView(context);
        chipScroll.setHorizontalScrollBarEnabled(false);
        chipScroll.setClipToPadding(false);
        chipScroll.setClipChildren(false);
        chipScroll.setPadding(0, ui.px(8), 0, ui.px(8));
        chips = new LinearLayout(context);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setClipChildren(false);
        chipScroll.addView(chips, new FrameLayout.LayoutParams(Ui.WRAP, Ui.WRAP));
        LinearLayout.LayoutParams cp = ui.lin(Ui.MATCH, Ui.WRAP);
        cp.topMargin = ui.px(12);
        col.addView(chipScroll, cp);

        rowScroll = new ScrollView(context);
        rowScroll.setVerticalScrollBarEnabled(false);
        // Clipped to the padding so scrolled rows never draw under the season chips (the column
        // does not clip its children; the focus ring is drawn by the overlay, outside this view).
        rowScroll.setClipToPadding(true);
        rowScroll.setPadding(ui.px(8), ui.px(8), ui.px(8), ui.px(52));
        rows = new LinearLayout(context);
        rows.setOrientation(LinearLayout.VERTICAL);
        rowScroll.addView(rows, new FrameLayout.LayoutParams(Ui.MATCH, Ui.WRAP));
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(Ui.MATCH, 0, 1f);
        rp.topMargin = ui.px(8);
        rp.leftMargin = -ui.px(8);
        rp.rightMargin = -ui.px(8);
        col.addView(rowScroll, rp);

        addView(col, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.TOP));
    }

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    public boolean hasEpisodes() {
        return !seasons.isEmpty();
    }

    /** Binds the seasons; {@code season} (may be null) is the one shown first. */
    public void bind(List<VideoRequest.Season> seasons, @Nullable VideoRequest.Season season, String currentItemKey) {
        this.seasons = seasons;
        this.currentKey = currentItemKey;
        chips.removeAllViews();
        chipViews.clear();
        for (int i = 0; i < seasons.size(); i++) {
            final int pos = i;
            TextView chip = ui.text(14, 600, ui.theme.text);
            chip.setText(seasons.get(i).title);
            chip.setSingleLine(true);
            chip.setGravity(Gravity.CENTER);
            chip.setPadding(ui.px(16), ui.px(7), ui.px(16), ui.px(7));
            Ui.focusable(chip, 999);
            chip.setOnClickListener(v -> showSeason(pos));
            LinearLayout.LayoutParams lp = ui.lin(Ui.WRAP, Ui.WRAP);
            if (i > 0) lp.leftMargin = ui.px(8);
            chips.addView(chip, lp);
            chipViews.add(chip);
        }
        chipScroll.setVisibility(seasons.size() > 1 ? VISIBLE : GONE);
        int idx = season == null ? 0 : Math.max(0, seasons.indexOf(season));
        shownSeason = -1;
        if (!seasons.isEmpty()) showSeason(idx);
    }

    private void showSeason(int pos) {
        if (pos == shownSeason) return;
        shownSeason = pos;
        for (int i = 0; i < chipViews.size(); i++) {
            boolean sel = i == pos;
            TextView c = chipViews.get(i);
            c.setTextColor(sel ? ui.theme.bg : ui.theme.text);
            c.setBackground(ui.round(sel ? ui.theme.text : ui.theme.chip, 999));
        }
        rows.removeAllViews();
        currentRow = null;
        VideoRequest.Season s = seasons.get(pos);
        for (int i = 0; i < s.episodes.size(); i++) {
            VideoRequest.Episode e = s.episodes.get(i);
            View row = row(e);
            LinearLayout.LayoutParams lp = ui.lin(Ui.MATCH, Ui.WRAP);
            if (i > 0) lp.topMargin = ui.px(6);
            rows.addView(row, lp);
            if (e.itemKey.equals(currentKey)) currentRow = row;
        }
        rowScroll.scrollTo(0, 0);
    }

    private View row(VideoRequest.Episode e) {
        boolean current = e.itemKey.equals(currentKey);
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(ui.px(8), ui.px(8), ui.px(8), ui.px(8));
        row.setBackground(ui.round(current ? ui.theme.chip : 0, 10));
        Ui.focusable(row, 10);
        row.setOnClickListener(v -> {
            if (listener != null) listener.onEpisodePicked(e);
        });

        FrameLayout thumbBox = new FrameLayout(getContext());
        thumbBox.setBackground(ui.round(ui.theme.fill, 6));
        thumbBox.setClipToOutline(true);
        ImageView thumb = new ImageView(getContext());
        thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        thumbBox.addView(thumb, ui.frame(Ui.MATCH, Ui.MATCH, Gravity.CENTER));
        images.into(thumb, e.thumbUrl, ui.px(160), null);
        float progress = e.progress != null ? e.progress : (e.played ? 1f : 0f);
        if (progress > 0) {
            ProgressStrip strip = new ProgressStrip(getContext(), progress);
            thumbBox.addView(strip, ui.frame(Ui.MATCH, ui.px(3), Gravity.BOTTOM));
        }
        row.addView(thumbBox, ui.lin(ui.px(160), ui.px(90)));

        LinearLayout col = new LinearLayout(getContext());
        col.setOrientation(LinearLayout.VERTICAL);
        TextView title = ui.line(15, 700, ui.theme.text, 2);
        title.setText(OverlayStrings.rowTitle(e.episodeNumber, e.title));
        col.addView(title, ui.lin(Ui.MATCH, Ui.WRAP));

        LinearLayout metaRow = new LinearLayout(getContext());
        metaRow.setOrientation(LinearLayout.HORIZONTAL);
        boolean any = false;
        if (e.runtime != null && !e.runtime.isEmpty()) {
            TextView rt = ui.text(13, 400, ui.theme.text3);
            rt.setText(e.runtime);
            metaRow.addView(rt, ui.lin(Ui.WRAP, Ui.WRAP));
            any = true;
        }
        if (current) {
            TextView now = ui.text(13, 700, ui.theme.accent);
            now.setText(ui.strings.get("nowPlaying"));
            LinearLayout.LayoutParams np = ui.lin(Ui.WRAP, Ui.WRAP);
            if (any) np.leftMargin = ui.px(10);
            metaRow.addView(now, np);
            any = true;
        }
        if (any) {
            LinearLayout.LayoutParams mp = ui.lin(Ui.MATCH, Ui.WRAP);
            mp.topMargin = ui.px(4);
            col.addView(metaRow, mp);
        }
        if (e.overview != null && !e.overview.isEmpty()) {
            TextView ov = ui.line(13, 400, ui.theme.text2, 2);
            ov.setText(e.overview);
            ov.setLineSpacing(0, 1.3f);
            LinearLayout.LayoutParams op = ui.lin(Ui.MATCH, Ui.WRAP);
            op.topMargin = ui.px(6);
            col.addView(ov, op);
        }
        LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(0, Ui.WRAP, 1f);
        colLp.leftMargin = ui.px(14);
        colLp.gravity = Gravity.CENTER_VERTICAL;
        row.addView(col, colLp);
        return row;
    }

    @Override
    public void open() {
        super.open();
        View f = currentRow;
        if (f != null) {
            f.post(() -> rowScroll.smoothScrollTo(0, Math.max(0, f.getTop() - ui.px(8))));
        }
    }

    @Nullable
    @Override
    protected View initialFocus() {
        if (currentRow != null) return currentRow;
        if (rows.getChildCount() > 0) return rows.getChildAt(0);
        return chipViews.isEmpty() ? null : chipViews.get(0);
    }

    /** A 3 px progress line at the bottom of the thumbnail: accent on the track colour. */
    private final class ProgressStrip extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float f;

        ProgressStrip(Context c, float f) {
            super(c);
            this.f = Math.max(0, Math.min(1, f));
        }

        @Override
        protected void onDraw(Canvas c) {
            paint.setColor(ui.theme.track);
            c.drawRect(0, 0, getWidth(), getHeight(), paint);
            paint.setColor(ui.theme.accent);
            c.drawRect(0, 0, getWidth() * f, getHeight(), paint);
        }
    }
}
