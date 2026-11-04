package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** The player chrome's worked-out text (S16 info line, S18 cause, S19 question). */
public class PlayerChromeTest {

    @Test
    public void infoSplitsDeliveryFromBadges() {
        PlayerChrome.Info i = PlayerChrome.info("Direct play · 4K HDR10", 6);
        assertEquals("Direct play", i.method);
        assertEquals(Arrays.asList("4K HDR10", "5.1"), i.badges);
    }

    @Test
    public void infoWithoutStreamInfo() {
        PlayerChrome.Info i = PlayerChrome.info(null, 2);
        assertNull(i.method);
        assertEquals(Collections.emptyList(), i.badges);
        assertEquals(Collections.singletonList("7.1"), PlayerChrome.info(null, 8).badges);
    }

    @Test
    public void infoDeliveryOnly() {
        PlayerChrome.Info i = PlayerChrome.info("Converted", null);
        assertEquals("Converted", i.method);
        assertTrue(i.badges.isEmpty());
    }

    @Test
    public void channelsBadge() {
        assertNull(PlayerChrome.channelsBadge(null));
        assertNull(PlayerChrome.channelsBadge(1));
        assertNull(PlayerChrome.channelsBadge(2));
        assertEquals("5.1", PlayerChrome.channelsBadge(6));
        assertEquals("6.1", PlayerChrome.channelsBadge(7));
        assertEquals("7.1", PlayerChrome.channelsBadge(8));
        assertEquals("4ch", PlayerChrome.channelsBadge(4));
    }

    @Test
    public void errorMessageKeys() {
        assertEquals("errorForbidden", PlayerChrome.errorMessageKey("auth"));
        assertEquals("errorNetwork", PlayerChrome.errorMessageKey("network"));
        assertEquals("errorNetwork", PlayerChrome.errorMessageKey("file"));
        assertEquals("errorUnsupported", PlayerChrome.errorMessageKey("unsupported"));
        assertEquals("errorUnsupported", PlayerChrome.errorMessageKey("decoder"));
        assertEquals("errorBusy", PlayerChrome.errorMessageKey("busy"));
        assertEquals("errorTimeout", PlayerChrome.errorMessageKey("timeout"));
        assertEquals("errorLoad", PlayerChrome.errorMessageKey("unknown"));
        assertEquals("errorLoad", PlayerChrome.errorMessageKey(null));
    }

    @Test
    public void stillWatchingAfterThreeAutoplays() {
        assertFalse(PlayerChrome.askStillWatching(0));
        assertFalse(PlayerChrome.askStillWatching(2));
        assertTrue(PlayerChrome.askStillWatching(3));
    }

    @Test
    public void overlayStringTemplates() {
        Map<String, String> m = new HashMap<>();
        m.put("upNextIn", "Up next in {s}");
        m.put("stillWatchingBody", "{title} · {n} episodes played in a row.");
        m.put("errorDetail", "Error {code} · {time} · stopped at {position}");
        OverlayStrings s = new OverlayStrings(m, null);
        assertEquals("Up next in 12", s.upNextIn(12));
        assertEquals("Up next in 0", s.upNextIn(-3));
        assertEquals("Ember County · 3 episodes played in a row.", s.stillWatchingBody("Ember County", 3));
        assertEquals("Error network · 21:14:07 · stopped at 19:12", s.errorDetail("network", "21:14:07", "19:12"));
    }
}
