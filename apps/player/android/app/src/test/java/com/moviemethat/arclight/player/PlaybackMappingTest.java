package com.moviemethat.arclight.player;

import static org.junit.Assert.assertEquals;

import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import org.junit.Test;

public class PlaybackMappingTest {

    @Test
    public void status() {
        assertEquals("error", PlaybackMapping.status(Player.STATE_READY, true, true, true, true, false));
        assertEquals("idle", PlaybackMapping.status(Player.STATE_READY, true, false, true, false, false));
        assertEquals("loading", PlaybackMapping.status(Player.STATE_BUFFERING, true, false, false, true, false));
        assertEquals("buffering", PlaybackMapping.status(Player.STATE_BUFFERING, true, false, true, true, false));
        assertEquals("paused", PlaybackMapping.status(Player.STATE_BUFFERING, false, false, true, true, false));
        assertEquals("playing", PlaybackMapping.status(Player.STATE_READY, true, false, true, true, false));
        assertEquals("paused", PlaybackMapping.status(Player.STATE_READY, true, false, true, true, true));
        assertEquals("ended", PlaybackMapping.status(Player.STATE_ENDED, false, false, true, true, false));
    }

    @Test
    public void errorCodes() {
        assertEquals("auth", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 401, false));
        assertEquals("auth", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 403, false));
        assertEquals("busy", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 429, false));
        assertEquals("network", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 502, false));
        assertEquals("network", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, 0, false));
        assertEquals("file", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, 0, true));
        assertEquals("unsupported", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, 0, false));
        assertEquals("unknown", PlaybackMapping.errorCode(PlaybackException.ERROR_CODE_UNSPECIFIED, 0, false));
    }

    @Test
    public void clampsAndRepeat() {
        assertEquals(0.5f, PlaybackMapping.clampRate(0.1), 0f);
        assertEquals(3.5f, PlaybackMapping.clampRate(9), 0f);
        assertEquals(1f, PlaybackMapping.clampRate(Double.NaN), 0f);
        assertEquals(1.25f, PlaybackMapping.clampRate(1.25), 0f);
        assertEquals(0f, PlaybackMapping.clampVolume(-1), 0f);
        assertEquals(1f, PlaybackMapping.clampVolume(2), 0f);
        for (String m : new String[] {"off", "one", "all"}) {
            assertEquals(m, PlaybackMapping.repeatName(PlaybackMapping.repeatMode(m)));
        }
        assertEquals("off", PlaybackMapping.repeatName(PlaybackMapping.repeatMode("bogus")));
        assertEquals("auto", PlaybackMapping.transitionReason(Player.MEDIA_ITEM_TRANSITION_REASON_AUTO));
        assertEquals("skip", PlaybackMapping.transitionReason(Player.MEDIA_ITEM_TRANSITION_REASON_SEEK));
    }
}
