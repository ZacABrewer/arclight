package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** The redesign's PlayVideoOptions fields: pause, trickplay, seasons, prefs, theme, strings. */
public class VideoRequestRedesignTest {

    private static final String BASE = "\"itemKey\":\"episode:42\",\"url\":\"https://example.com/v/42.mp4\"";

    private static VideoRequest parse(String extra) throws Exception {
        return VideoRequest.parse(new JSONObject("{" + BASE + (extra.isEmpty() ? "" : "," + extra) + "}"));
    }

    @Test
    public void defaultsWhenAbsent() throws Exception {
        VideoRequest r = parse("");
        assertNull(r.pause);
        assertNull(r.trickplay);
        assertTrue(r.seasons.isEmpty());
        assertNull(r.currentSeason);
        assertNull(r.panelSeason());
        assertNull(r.theme);
        assertTrue(r.strings.isEmpty());
        assertEquals("medium", r.prefs.subtitleSize);
        assertFalse(r.prefs.skipIntros);
        assertTrue(r.prefs.autoplayNext);
        assertFalse(r.prefs.cyanGlow());
        assertFalse(r.prefs.reduceMotion);
    }

    @Test
    public void parsesPause() throws Exception {
        VideoRequest r = parse("\"pause\":{\"title\":\"Ember County\",\"episodeLine\":\"S2 · E5 · Ashfall\","
                + "\"meta\":[{\"text\":\"TV-14\",\"boxed\":true},{\"text\":\"4K\",\"chip\":true},{\"text\":\"2026\"},{\"boxed\":true},\"x\"],"
                + "\"overview\":\"A fire.\",\"logoUrl\":null,\"backdropUrl\":\"https://example.com/b.jpg\"}");
        VideoRequest.Pause p = r.pause;
        assertNotNull(p);
        assertEquals("Ember County", p.title);
        assertEquals("S2 · E5 · Ashfall", p.episodeLine);
        assertEquals(3, p.meta.size());
        assertTrue(p.meta.get(0).boxed);
        assertTrue(p.meta.get(1).chip);
        assertFalse(p.meta.get(2).boxed || p.meta.get(2).chip);
        assertEquals("A fire.", p.overview);
        assertNull(p.logoUrl);
        assertEquals("https://example.com/b.jpg", p.backdropUrl);
        // No title: no pause info.
        assertNull(parse("\"pause\":{\"overview\":\"x\"}").pause);
    }

    @Test
    public void parsesTrickplay() throws Exception {
        VideoRequest r = parse("\"trickplay\":{\"intervalMs\":10000,\"tileWidth\":320,\"tileHeight\":180,\"columns\":10,"
                + "\"rows\":10,\"tileCount\":250,\"sheets\":[\"https://example.com/0.jpg\",\"\",\"https://example.com/1.jpg\"]}");
        assertNotNull(r.trickplay);
        assertEquals(10_000, r.trickplay.intervalMs);
        assertEquals(2, r.trickplay.sheets.size());
        // Any zero dimension, or no sheets: none.
        assertNull(parse("\"trickplay\":{\"intervalMs\":10000,\"tileWidth\":0,\"tileHeight\":180,\"columns\":10,"
                + "\"rows\":10,\"tileCount\":250,\"sheets\":[\"a\"]}").trickplay);
        assertNull(parse("\"trickplay\":{\"intervalMs\":10000,\"tileWidth\":320,\"tileHeight\":180,\"columns\":10,"
                + "\"rows\":10,\"tileCount\":250,\"sheets\":[]}").trickplay);
    }

    private static final String SEASONS = "\"seasons\":["
            + "{\"seasonNumber\":1,\"title\":\"Season 1\",\"episodes\":["
            + "{\"itemKey\":\"episode:1\",\"episodeNumber\":1,\"title\":\"1. Pilot\",\"runtime\":\"52m\",\"progress\":1.4,\"played\":true},"
            + "{\"episodeNumber\":2,\"title\":\"no key\"}]},"
            + "{\"seasonNumber\":2,\"episodes\":["
            + "{\"itemKey\":\"episode:41\",\"episodeNumber\":4,\"title\":\"4. Embers\",\"progress\":-1},"
            + "{\"itemKey\":\"episode:42\",\"episodeNumber\":5,\"title\":\"5. Ashfall\",\"progress\":null,\"thumbUrl\":\"https://example.com/t.jpg\"}]},"
            + "{\"seasonNumber\":3,\"episodes\":[]}]";

    @Test
    public void parsesSeasons() throws Exception {
        VideoRequest r = parse(SEASONS);
        assertEquals(2, r.seasons.size());
        VideoRequest.Season s1 = r.seasons.get(0);
        assertEquals("Season 1", s1.title);
        // The episode without an itemKey is dropped; progress is clamped to 0..1.
        assertEquals(1, s1.episodes.size());
        assertEquals(1f, s1.episodes.get(0).progress, 0f);
        assertTrue(s1.episodes.get(0).played);
        assertEquals("52m", s1.episodes.get(0).runtime);
        VideoRequest.Season s2 = r.seasons.get(1);
        // No title: the number.
        assertEquals("2", s2.title);
        assertEquals(0f, s2.episodes.get(0).progress, 0f);
        assertNull(s2.episodes.get(1).progress);
        assertEquals("https://example.com/t.jpg", s2.episodes.get(1).thumbUrl);
    }

    @Test
    public void panelSeasonPicksCurrent() throws Exception {
        // The season holding this item (episode:42 is in season 2).
        VideoRequest r = parse(SEASONS);
        assertSame(r.seasons.get(1), r.panelSeason());
        // currentSeason wins.
        VideoRequest c = parse(SEASONS + ",\"currentSeason\":1");
        assertEquals(Integer.valueOf(1), c.currentSeason);
        assertSame(c.seasons.get(0), c.panelSeason());
        // Unknown currentSeason and an item in no season: the first.
        VideoRequest u = VideoRequest.parse(new JSONObject("{\"itemKey\":\"movie:9\",\"url\":\"https://example.com/m.mp4\","
                + SEASONS + ",\"currentSeason\":7}"));
        assertSame(u.seasons.get(0), u.panelSeason());
    }

    @Test
    public void parsesPrefs() throws Exception {
        VideoRequest r = parse("\"prefs\":{\"subtitleSize\":\"large\",\"skipIntros\":true,\"autoplayNext\":false,"
                + "\"focusStyle\":\"cyan-glow\",\"reduceMotion\":true}");
        assertEquals("large", r.prefs.subtitleSize);
        assertTrue(r.prefs.skipIntros);
        assertFalse(r.prefs.autoplayNext);
        assertTrue(r.prefs.cyanGlow());
        assertTrue(r.prefs.reduceMotion);
        // Unknown values normalise.
        VideoRequest b = parse("\"prefs\":{\"subtitleSize\":\"huge\",\"focusStyle\":\"neon\"}");
        assertEquals("medium", b.prefs.subtitleSize);
        assertEquals("white-frame", b.prefs.focusStyle);
        assertTrue(b.prefs.autoplayNext);
    }

    @Test
    public void parsesThemeAndStrings() throws Exception {
        VideoRequest r = parse("\"theme\":{\"bg\":\"#101010\"},\"strings\":{\"upNext\":\"Als Nächstes\",\"nextIn\":\"In {s} s\"}");
        assertNotNull(r.theme);
        assertEquals(0xFF101010, new OverlayTheme(r.theme).bg);
        assertEquals("Als Nächstes", r.strings.get("upNext"));
        assertEquals("In 3 s", new OverlayStrings(r.strings, null).nextIn(3));
    }
}
