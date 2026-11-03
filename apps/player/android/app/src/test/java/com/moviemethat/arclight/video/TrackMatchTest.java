package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Direct play reports the JS-side audio ordinal for ExoPlayer's track group, or nothing. */
public class TrackMatchTest {

    private static VideoRequest.AudioTrack js(int index, String lang, String codec, Integer channels, String title) {
        return new VideoRequest.AudioTrack(index, "#" + index, lang, codec, channels, title);
    }

    private static TrackMatch.FileTrack file(String lang, String mime, int channels, String label) {
        return new TrackMatch.FileTrack(lang, label, mime, channels);
    }

    @Test
    public void alignedListsMapByPosition() {
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "eac3", 6, null), js(1, "ger", "ac3", 6, null));
        List<TrackMatch.FileTrack> f = Arrays.asList(file("en", "audio/eac3", 6, null), file("de", "audio/ac3", 6, null));
        assertEquals(Integer.valueOf(0), TrackMatch.jsIndexFor(j, f, 0));
        assertEquals(Integer.valueOf(1), TrackMatch.jsIndexFor(j, f, 1));
    }

    @Test
    public void reorderedListsMapByLanguageNotPosition() {
        // ExoPlayer lists German first; the group index (0) must not be reported as JS track 0 (English).
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "eac3", 6, null), js(1, "fre", "ac3", 2, null));
        List<TrackMatch.FileTrack> f = Arrays.asList(file("fr", "audio/ac3", 2, null), file("en-US", "audio/eac3", 6, null));
        assertEquals(Integer.valueOf(1), TrackMatch.jsIndexFor(j, f, 0));
        assertEquals(Integer.valueOf(0), TrackMatch.jsIndexFor(j, f, 1));
    }

    @Test
    public void differentCountsStillMatchWhenUnambiguous() {
        // JS knows three tracks; ExoPlayer exposes two (one unsupported codec dropped).
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "truehd", 8, null), js(1, "eng", "ac3", 6, null), js(2, "spa", "ac3", 6, null));
        List<TrackMatch.FileTrack> f = Arrays.asList(file("en", "audio/ac3", 6, null), file("es", "audio/ac3", 6, null));
        assertEquals(Integer.valueOf(1), TrackMatch.jsIndexFor(j, f, 0));
        assertEquals(Integer.valueOf(2), TrackMatch.jsIndexFor(j, f, 1));
    }

    @Test
    public void titleBreaksTiesWithinALanguage() {
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "ac3", 6, "Main"), js(1, "eng", "ac3", 6, "Commentary"));
        List<TrackMatch.FileTrack> f = Collections.singletonList(file("en", "audio/ac3", 6, "Commentary"));
        assertEquals(Integer.valueOf(1), TrackMatch.jsIndexFor(j, f, 0));
    }

    @Test
    public void ambiguousOrUnknownGivesNull() {
        // Two English tracks, no titles, and ExoPlayer shows only one of them: which one is unknown.
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "ac3", 6, null), js(1, "eng", "ac3", 6, null));
        assertNull(TrackMatch.jsIndexFor(j, Collections.singletonList(file("en", "audio/ac3", 6, null)), 0));
        // No language anywhere and nothing else telling them apart.
        List<VideoRequest.AudioTrack> bare = Arrays.asList(js(0, null, null, null, null), js(1, null, null, null, null));
        List<TrackMatch.FileTrack> bareFile = Arrays.asList(file(null, null, -1, null), file("und", null, -1, null));
        assertNull(TrackMatch.jsIndexFor(bare, bareFile, 1));
        // A language JS does not have at all.
        List<VideoRequest.AudioTrack> one = Arrays.asList(js(0, "eng", "aac", 2, null), js(1, "ger", "aac", 2, null));
        assertNull(TrackMatch.jsIndexFor(one, Collections.singletonList(file("ja", "audio/mp4a-latm", 2, null)), 0));
        // Out of range.
        assertNull(TrackMatch.jsIndexFor(one, Collections.singletonList(file("en", null, -1, null)), 3));
        assertNull(TrackMatch.jsIndexFor(Collections.emptyList(), Collections.singletonList(file("en", null, -1, null)), 0));
    }

    @Test
    public void singleCandidateNeedsPositiveEvidence() {
        // Only the AAC track is compatible with an untagged AAC group: the codec agrees, so it is taken.
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "aac", 2, null), js(1, "ger", "dts", 6, null), js(2, "fre", "ac3", 6, null));
        assertEquals(Integer.valueOf(0), TrackMatch.jsIndexFor(j, Collections.singletonList(file(null, "audio/mp4a-latm", 2, null)), 0));
    }

    @Test
    public void groupForFindsTheFileTrackOfAJsIndex() {
        List<VideoRequest.AudioTrack> j = Arrays.asList(js(0, "eng", "eac3", 6, null), js(1, "fre", "ac3", 2, null));
        List<TrackMatch.FileTrack> f = Arrays.asList(file("fr", "audio/ac3", 2, null), file("en", "audio/eac3", 6, null));
        assertEquals(1, TrackMatch.groupFor(j, f, 0));
        assertEquals(0, TrackMatch.groupFor(j, f, 1));
        // Nothing maps: the same position as before.
        assertEquals(1, TrackMatch.groupFor(Collections.emptyList(), f, 1));
    }

    @Test
    public void normalisesLanguagesAndCodecs() {
        assertEquals("eng", TrackMatch.language("en"));
        assertEquals("eng", TrackMatch.language("en-GB"));
        assertEquals("deu", TrackMatch.language("ger"));
        assertEquals("deu", TrackMatch.language("de"));
        assertEquals("fra", TrackMatch.language("fre"));
        assertNull(TrackMatch.language("und"));
        assertNull(TrackMatch.language(""));
        assertEquals("dts", TrackMatch.codecFamily("dca"));
        assertEquals("pcm", TrackMatch.codecFamily("pcm_s24le"));
        assertEquals("dts", TrackMatch.mimeFamily("audio/vnd.dts.hd"));
        assertEquals("aac", TrackMatch.mimeFamily("audio/mp4a-latm"));
        assertNull(TrackMatch.codecFamily("something-new"));
    }

    @Test
    public void parsesTheExtraAudioFields() throws Exception {
        JSONArray arr = new JSONArray()
                .put(new JSONObject().put("index", 0).put("label", "English").put("language", "eng").put("codec", "eac3").put("channels", 6).put("title", "Main"))
                .put(new JSONObject().put("index", 1).put("label", "Old"));
        List<VideoRequest.AudioTrack> out = VideoRequest.parseAudio(arr);
        assertEquals("eng", out.get(0).language);
        assertEquals("eac3", out.get(0).codec);
        assertEquals(Integer.valueOf(6), out.get(0).channels);
        assertEquals("Main", out.get(0).title);
        assertNull(out.get(1).language);
        assertNull(out.get(1).channels);
    }
}
