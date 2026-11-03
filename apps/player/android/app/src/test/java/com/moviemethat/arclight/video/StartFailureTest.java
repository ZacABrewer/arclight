package com.moviemethat.arclight.video;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.PlaybackException;
import androidx.media3.datasource.HttpDataSource.HttpDataSourceException;
import org.junit.Test;

public class StartFailureTest {

    @Test
    public void givesUpWhenTheServerCannotBeReachedAtTheStart() {
        assertTrue(StartFailure.giveUp(false, HttpDataSourceException.TYPE_OPEN, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED));
        assertTrue(StartFailure.giveUp(false, HttpDataSourceException.TYPE_OPEN, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT));
    }

    @Test
    public void keepsRetriesOnceItPlayedOrForOtherErrors() {
        assertFalse(StartFailure.giveUp(true, HttpDataSourceException.TYPE_OPEN, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED));
        assertFalse(StartFailure.giveUp(false, HttpDataSourceException.TYPE_READ, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT));
        assertFalse(StartFailure.giveUp(false, HttpDataSourceException.TYPE_OPEN, PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS));
    }

    @Test
    public void connectsWithinTenSeconds() {
        assertTrue(StartFailure.CONNECT_TIMEOUT_MS >= 8_000 && StartFailure.CONNECT_TIMEOUT_MS <= 10_000);
    }
}
