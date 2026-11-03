package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LoadControlConfigTest {

    @Test
    public void phonesBufferLongerThanTvs() {
        LoadControlConfig phone = LoadControlConfig.forDevice(false, false, 256);
        assertEquals(30_000, phone.minBufferMs);
        assertEquals(120_000, phone.maxBufferMs);
        assertEquals(2_500, phone.bufferForPlaybackMs);
        assertEquals(5_000, phone.bufferForPlaybackAfterRebufferMs);
        assertEquals(30_000, phone.backBufferMs);
        assertTrue(phone.retainBackBufferFromKeyframe);

        assertEquals(60_000, LoadControlConfig.forDevice(true, false, 256).maxBufferMs);
        assertEquals(60_000, LoadControlConfig.forDevice(false, true, 256).maxBufferMs);
    }

    @Test
    public void byteCeilingIsAQuarterOfTheHeapWithinBounds() {
        assertEquals(64 * LoadControlConfig.MB, LoadControlConfig.forDevice(false, false, 256).targetBufferBytes);
        assertEquals(LoadControlConfig.MIN_TARGET_BYTES, LoadControlConfig.forDevice(true, true, 96).targetBufferBytes);
        assertEquals(LoadControlConfig.MIN_TARGET_BYTES, LoadControlConfig.forDevice(true, false, 0).targetBufferBytes);
        assertEquals(LoadControlConfig.MAX_TARGET_BYTES, LoadControlConfig.forDevice(false, false, 1024).targetBufferBytes);
        // Size wins over time, so a high-bitrate stream cannot run the heap out.
        assertFalse(LoadControlConfig.forDevice(false, false, 512).prioritizeTimeOverSizeThresholds);
    }
}
