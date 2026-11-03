package com.moviemethat.arclight;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Before;
import org.junit.Test;

public class LaunchInfoTest {

    private static Set<String> cats(String... c) {
        Set<String> s = new HashSet<>();
        Collections.addAll(s, c);
        return s;
    }

    @Before
    public void setUp() {
        LaunchInfo.reset();
    }

    @Test
    public void classifiesLauncher() {
        assertEquals("launcher", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats(LaunchInfo.CATEGORY_LAUNCHER), false, null, false));
        assertEquals("launcher", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats(LaunchInfo.CATEGORY_LEANBACK_LAUNCHER), false, null, false));
        assertEquals("launcher", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, null, false, null, false));
        assertEquals("other", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats("android.intent.category.INFO"), false, null, false));
    }

    @Test
    public void classifiesOtherSources() {
        assertEquals("deep-link", LaunchInfo.classify(LaunchInfo.ACTION_VIEW, cats("android.intent.category.BROWSABLE"), true, null, false));
        assertEquals("other", LaunchInfo.classify(LaunchInfo.ACTION_VIEW, null, false, null, false));
        assertEquals("media-button", LaunchInfo.classify(LaunchInfo.ACTION_MEDIA_BUTTON, null, false, null, false));
        assertEquals("car", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats(LaunchInfo.CATEGORY_CAR_MODE), false, null, false));
        assertEquals("other", LaunchInfo.classify(null, null, false, null, false));
    }

    @Test
    public void extraWinsAndRestoredIsOther() {
        assertEquals("notification", LaunchInfo.classify(null, null, false, "notification", false));
        assertEquals("notification",
                LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats(LaunchInfo.CATEGORY_LAUNCHER), false, "notification", true));
        // An unknown extra is ignored.
        assertEquals("launcher", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, null, false, "bogus", false));
        assertEquals("other", LaunchInfo.classify(LaunchInfo.ACTION_MAIN, cats(LaunchInfo.CATEGORY_LAUNCHER), false, null, true));
    }

    @Test
    public void consumeIsColdOnce() {
        LaunchInfo.record("deep-link");
        // Later launches do not overwrite the first.
        LaunchInfo.record("launcher");
        LaunchInfo first = LaunchInfo.consume(true);
        assertTrue(first.coldStart);
        assertEquals("deep-link", first.source);
        assertTrue(first.systemReducedMotion);
        LaunchInfo second = LaunchInfo.consume(false);
        assertFalse(second.coldStart);
        assertEquals("deep-link", second.source);
        assertFalse(second.systemReducedMotion);
    }

    @Test
    public void consumeWithoutRecordIsOther() {
        LaunchInfo i = LaunchInfo.consume(false);
        assertTrue(i.coldStart);
        assertEquals("other", i.source);
    }
}
