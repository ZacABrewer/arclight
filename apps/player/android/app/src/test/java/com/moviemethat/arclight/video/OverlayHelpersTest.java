package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONObject;
import org.junit.Test;

/** The pure helpers behind the redesigned native overlay. */
public class OverlayHelpersTest {

    // ---- TrickplayMath (same rule as trickplayTileAt in packages/shared) -----------------------

    private final VideoRequest.Trickplay tp =
            new VideoRequest.Trickplay(10_000, 320, 180, 10, 10, 250, Arrays.asList("a.jpg", "b.jpg", "c.jpg"));

    @Test
    public void trickplayFirstTile() {
        TrickplayMath.Tile t = TrickplayMath.tileAt(tp, 0);
        assertEquals(0, t.sheet);
        assertEquals(0, t.x);
        assertEquals(0, t.y);
    }

    @Test
    public void trickplayInsideSheet() {
        // 125 s -> tile 12: column 2, row 1.
        TrickplayMath.Tile t = TrickplayMath.tileAt(tp, 125_000);
        assertEquals(0, t.sheet);
        assertEquals(640, t.x);
        assertEquals(180, t.y);
        // Just before the boundary stays on tile 12.
        assertEquals(640, TrickplayMath.tileAt(tp, 129_999).x);
    }

    @Test
    public void trickplayNextSheet() {
        // Tile 100 is the first of sheet 1; tile 213 -> sheet 2, col 3, row 1.
        assertEquals(1, TrickplayMath.tileAt(tp, 1_000_000).sheet);
        TrickplayMath.Tile t = TrickplayMath.tileAt(tp, 2_135_000);
        assertEquals(2, t.sheet);
        assertEquals(960, t.x);
        assertEquals(180, t.y);
    }

    @Test
    public void trickplayClamps() {
        // Past the end: the last tile (249 -> sheet 2, col 9, row 4); negative: the first.
        TrickplayMath.Tile last = TrickplayMath.tileAt(tp, 99_000_000);
        assertEquals(2, last.sheet);
        assertEquals(9 * 320, last.x);
        assertEquals(4 * 180, last.y);
        TrickplayMath.Tile neg = TrickplayMath.tileAt(tp, -5_000);
        assertEquals(0, neg.sheet);
        assertEquals(0, neg.x);
    }

    // ---- EndsAt ----------------------------------------------------------------------------

    private static final TimeZone UTC = TimeZone.getTimeZone("UTC");

    @Test
    public void endsAt12h() {
        // 1970-01-01 20:00 UTC + 1 h 42 min.
        long now = 20L * 3_600_000;
        assertEquals("9:42 PM", EndsAt.format(now, 102 * 60_000L, UTC, Locale.US, false));
    }

    @Test
    public void endsAt24h() {
        long now = 20L * 3_600_000;
        assertEquals("21:42", EndsAt.format(now, 102 * 60_000L, UTC, Locale.US, true));
        // Over midnight, and a negative remaining counts as zero.
        assertEquals("0:15", EndsAt.format(23L * 3_600_000, 75 * 60_000L, UTC, Locale.US, true));
        assertEquals("20:00", EndsAt.format(now, -5_000, UTC, Locale.US, true));
    }

    @Test
    public void endsAtFollowsZone() {
        long now = 20L * 3_600_000;
        assertEquals("22:00", EndsAt.format(now, 0, TimeZone.getTimeZone("GMT+02:00"), Locale.US, true));
    }

    // ---- OverlayStrings ----------------------------------------------------------------------

    @Test
    public void stringsPreferJsThenFallbackThenKey() {
        Map<String, String> js = new HashMap<>();
        js.put("upNext", "Als Nächstes");
        js.put("cancel", "");
        Map<String, String> fb = new HashMap<>();
        fb.put("upNext", "Up next");
        fb.put("cancel", "Cancel");
        OverlayStrings s = new OverlayStrings(js, fb);
        assertEquals("Als Nächstes", s.get("upNext"));
        // An empty JS string falls back.
        assertEquals("Cancel", s.get("cancel"));
        assertEquals("playNow", s.get("playNow"));
        assertEquals("x", new OverlayStrings(null, null).get("x"));
    }

    @Test
    public void stringsFillPlaceholders() {
        Map<String, String> fb = new HashMap<>();
        fb.put("nextIn", "Next episode in {s}s");
        fb.put("endsAt", "Ends at {time}");
        OverlayStrings s = new OverlayStrings(null, fb);
        assertEquals("Next episode in 8s", s.nextIn(8));
        assertEquals("Next episode in 0s", s.nextIn(-3));
        assertEquals("Ends at 9:42 PM", s.endsAt("9:42 PM"));
    }

    @Test
    public void rowTitle() {
        assertEquals("E5 · The Long Meridian", OverlayStrings.rowTitle(5, "5. The Long Meridian"));
        assertEquals("E12 · Pilot", OverlayStrings.rowTitle(12, " 12: Pilot"));
        assertEquals("E3 · Homecoming", OverlayStrings.rowTitle(3, "Homecoming"));
        assertEquals("E7", OverlayStrings.rowTitle(7, "7."));
        assertEquals("E2", OverlayStrings.rowTitle(2, null));
        // A number that is the whole title stays.
        assertEquals("E1 · 1985", OverlayStrings.rowTitle(1, "1985"));
    }

    // ---- OverlayTheme --------------------------------------------------------------------------

    @Test
    public void themeParsesHex() {
        assertEquals(Integer.valueOf(0xFF6EF6FF), OverlayTheme.parse("#6ef6ff"));
        assertEquals(Integer.valueOf(0xFFFFFFFF), OverlayTheme.parse("#fff"));
        assertEquals(Integer.valueOf(0x80112233), OverlayTheme.parse("#80112233"));
        assertNull(OverlayTheme.parse("6ef6ff"));
        assertNull(OverlayTheme.parse("#12345"));
        assertNull(OverlayTheme.parse("#zzzzzz"));
        assertNull(OverlayTheme.parse(null));
    }

    @Test
    public void cinemaDefaults() {
        OverlayTheme t = OverlayTheme.CINEMA;
        assertEquals(0xFF111316, t.bg);
        assertEquals(0xFFEEF1F4, t.text);
        assertEquals(0xFF7D848E, t.text4);
        assertEquals(0xFF262A30, t.line);
        assertEquals(0xFF5D646E, t.certBorder);
        assertEquals(OverlayTheme.alpha(0xFF111316, 0.97f), t.panel);
        assertEquals(OverlayTheme.alpha(0xFFFFFFFF, 0.14f), t.fill);
        assertEquals(8f, t.radiusButton, 0f);
    }

    @Test
    public void customThemeDerives() throws Exception {
        OverlayTheme t = new OverlayTheme(new JSONObject(
                "{\"bg\":\"#000000\",\"text\":\"#ffffff\",\"text3\":\"#a0a0a0\",\"accent\":\"bad\",\"radiusButton\":12}"));
        assertEquals(0xFF000000, t.bg);
        // Malformed accent: the default.
        assertEquals(0xFF6EF6FF, t.accent);
        assertEquals(12f, t.radiusButton, 0f);
        // line = bg mixed 10 % towards text.
        assertEquals(0xFF1A1A1A, t.line);
        assertEquals(OverlayTheme.mix(0xFFA0A0A0, 0xFF000000, 0.3f), t.text4);
    }

    @Test
    public void alphaAndMix() {
        assertEquals(0x80FFFFFF, OverlayTheme.alpha(0xFFFFFFFF, 0.5f));
        assertEquals(0x00123456, OverlayTheme.alpha(0xFF123456, -1f));
        assertEquals(0xFF808080, OverlayTheme.mix(0xFF000000, 0xFFFFFFFF, 0.5f));
        assertEquals(0xFF000000, OverlayTheme.mix(0xFF000000, 0xFFFFFFFF, 0f));
    }

    // ---- OverlayMetrics ------------------------------------------------------------------------

    @Test
    public void stageScale() {
        assertEquals(1f, OverlayMetrics.scale(1280, 720), 1e-6);
        assertEquals(1.5f, OverlayMetrics.scale(1920, 1080), 1e-6);
        // A phone in landscape (915 x 412 dp): the height limits.
        assertEquals(412f / 720f, OverlayMetrics.scale(915, 412), 1e-6);
        // A taller window: the width limits.
        assertEquals(0.5f, OverlayMetrics.scale(640, 720), 1e-6);
        assertEquals(1f, OverlayMetrics.scale(0, 0), 0f);
    }

    @Test
    public void previewClampsToSideMargins() {
        // Centred over the knob when there is room.
        assertEquals(640 - 120, OverlayMetrics.previewLeft(640, 240, 1280), 1e-3);
        // Near the left edge: 56; near the right edge: 1280 - 56 - 240.
        assertEquals(56, OverlayMetrics.previewLeft(60, 240, 1280), 1e-3);
        assertEquals(1280 - 56 - 240, OverlayMetrics.previewLeft(1270, 240, 1280), 1e-3);
    }

    @Test
    public void cornerAndCaptionBottoms() {
        assertEquals(168, OverlayMetrics.cornerBottom(true));
        assertEquals(48, OverlayMetrics.cornerBottom(false));
        assertEquals(232, OverlayMetrics.captionBottom(true));
        assertEquals(72, OverlayMetrics.captionBottom(false));
    }

    // ---- VideoTimeline additions ----------------------------------------------------------------

    @Test
    public void pauseInfoDue() {
        assertFalse(VideoTimeline.pauseInfoDue(-1, 0, 100_000));
        assertFalse(VideoTimeline.pauseInfoDue(10_000, 0, 15_999));
        assertTrue(VideoTimeline.pauseInfoDue(10_000, 0, 16_000));
        // Input after the pause restarts the 6 s.
        assertFalse(VideoTimeline.pauseInfoDue(10_000, 14_000, 19_000));
        assertTrue(VideoTimeline.pauseInfoDue(10_000, 14_000, 20_000));
    }

    @Test
    public void scrubSteps() {
        assertEquals(10_000, VideoTimeline.scrubStepMs(0));
        assertEquals(10_000, VideoTimeline.scrubStepMs(1_499));
        assertEquals(30_000, VideoTimeline.scrubStepMs(1_500));
        assertEquals(30_000, VideoTimeline.scrubStepMs(2_999));
        assertEquals(60_000, VideoTimeline.scrubStepMs(3_000));
        assertEquals(60_000, VideoTimeline.scrubStepMs(60_000));
    }

    private final VideoRequest.Segment intro = new VideoRequest.Segment("intro", 30_000, 90_000);
    private final VideoRequest.Segment recap = new VideoRequest.Segment("recap", 0, 20_000);
    private final VideoRequest.Segment credits = new VideoRequest.Segment("credits", 2_400_000, 2_520_000);
    private final List<VideoRequest.Segment> segs = Arrays.asList(recap, intro, credits);

    @Test
    public void skipEndsPlayback() {
        assertTrue(VideoTimeline.skipEndsPlayback(credits, false));
        assertFalse(VideoTimeline.skipEndsPlayback(credits, true));
        assertFalse(VideoTimeline.skipEndsPlayback(intro, false));
        assertFalse(VideoTimeline.skipEndsPlayback(null, false));
    }

    @Test
    public void autoSkipIntroOnly() {
        assertSame(intro, VideoTimeline.autoSkip(segs, 30_000, true, false));
        assertSame(intro, VideoTimeline.autoSkip(segs, 60_000, true, false));
        // Off, already skipped, in the recap, in the tail, or after.
        assertNull(VideoTimeline.autoSkip(segs, 60_000, false, false));
        assertNull(VideoTimeline.autoSkip(segs, 60_000, true, true));
        assertNull(VideoTimeline.autoSkip(segs, 5_000, true, false));
        assertNull(VideoTimeline.autoSkip(segs, 89_000, true, false));
        assertNull(VideoTimeline.autoSkip(segs, 2_450_000, true, false));
        assertNull(VideoTimeline.autoSkip(Collections.emptyList(), 60_000, true, false));
    }

    @Test
    public void endAction() {
        assertEquals(VideoTimeline.EndAction.NEXT, VideoTimeline.endAction(true, false, true));
        assertEquals(VideoTimeline.EndAction.CLOSE, VideoTimeline.endAction(true, false, false));
        assertEquals(VideoTimeline.EndAction.CLOSE, VideoTimeline.endAction(true, true, true));
        assertEquals(VideoTimeline.EndAction.CLOSE, VideoTimeline.endAction(false, false, true));
    }

    @Test
    public void captionSizes() {
        assertEquals(22, VideoTimeline.captionSize("small"));
        assertEquals(28, VideoTimeline.captionSize("medium"));
        assertEquals(36, VideoTimeline.captionSize("large"));
        assertEquals(28, VideoTimeline.captionSize("huge"));
        assertEquals(28, VideoTimeline.captionSize(null));
    }
}
