package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.junit.Test;

public class VideoTimelineTest {

    private static final long MIN = 60_000;
    private final VideoRequest.Segment intro = new VideoRequest.Segment("intro", 30_000, 90_000);
    private final VideoRequest.Segment credits = new VideoRequest.Segment("credits", 40 * MIN, 42 * MIN);
    private final List<VideoRequest.Segment> segs = Arrays.asList(intro, credits);

    @Test
    public void activeSkip() {
        assertNull(VideoTimeline.activeSkip(segs, 10_000, false));
        assertSame(intro, VideoTimeline.activeSkip(segs, 30_000, true));
        // Hidden in the last 1.5 s of the segment.
        assertNull(VideoTimeline.activeSkip(segs, 89_000, false));
        assertSame(credits, VideoTimeline.activeSkip(segs, 41 * MIN, false));
        assertNull(VideoTimeline.activeSkip(segs, 41 * MIN, true));
    }

    @Test
    public void upNextAt() {
        assertEquals(40 * MIN, VideoTimeline.upNextAtMs(42 * MIN, segs));
        assertEquals(42 * MIN - 20_000, VideoTimeline.upNextAtMs(42 * MIN, Collections.emptyList()));
        assertEquals(-1, VideoTimeline.upNextAtMs(50_000, Collections.emptyList()));
        assertEquals(-1, VideoTimeline.upNextAtMs(0, Collections.emptyList()));
        // A "credits" segment in the first half is not the end credits.
        List<VideoRequest.Segment> early = Collections.singletonList(new VideoRequest.Segment("credits", MIN, 2 * MIN));
        assertEquals(42 * MIN - 20_000, VideoTimeline.upNextAtMs(42 * MIN, early));
    }

    @Test
    public void completed() {
        assertTrue(VideoTimeline.completed(40 * MIN, 42 * MIN, segs));
        assertFalse(VideoTimeline.completed(39 * MIN, 42 * MIN, segs));
        assertTrue(VideoTimeline.completed(96 * MIN, 100 * MIN, Collections.emptyList()));
        assertFalse(VideoTimeline.completed(94 * MIN, 100 * MIN, Collections.emptyList()));
        assertFalse(VideoTimeline.completed(5, 0, Collections.emptyList()));
    }

    @Test
    public void seekSteps() {
        assertEquals(10_000, VideoTimeline.seekStepMs(0));
        assertEquals(30_000, VideoTimeline.seekStepMs(6));
        assertEquals(60_000, VideoTimeline.seekStepMs(16));
        assertEquals(0, VideoTimeline.clampSeek(-5, 100_000));
        assertEquals(99_000, VideoTimeline.clampSeek(500_000, 100_000));
        assertEquals(500_000, VideoTimeline.clampSeek(500_000, 0));
    }

    @Test
    public void clockAndChapters() throws Exception {
        assertEquals("0:00", VideoTimeline.clock(-1));
        assertEquals("2:03", VideoTimeline.clock(123_999));
        assertEquals("1:02:03", VideoTimeline.clock(3_723_000));
        // Parsed chapters come back sorted by start.
        List<VideoRequest.Chapter> ch = VideoRequest.parseChapters(new JSONArray(
                "[{\"title\":\"Two\",\"startMs\":60000},{\"title\":\"One\",\"startMs\":0}]"));
        assertEquals("One", ch.get(0).title);
        assertNull(VideoTimeline.chapterAt(Collections.emptyList(), 5));
        assertEquals("One", VideoTimeline.chapterAt(ch, 59_999));
        assertEquals("Two", VideoTimeline.chapterAt(ch, 60_000));
    }
}
