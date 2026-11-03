package com.moviemethat.arclight.video;

import androidx.media3.common.PlaybackException;
import androidx.media3.datasource.HttpDataSource;

/**
 * A stream whose server cannot be reached before it ever played. Media3 retries a failed load
 * three times, each waiting out the connect timeout, so an unreachable server took most of a
 * minute to report; this gives up on the first connect failure instead. Pure (tests).
 */
public final class StartFailure {

    /** How long opening the stream may take to connect (the app's API requests use the same). */
    public static final int CONNECT_TIMEOUT_MS = 9_000;

    private StartFailure() {}

    /**
     * Whether a load error is final: the connection itself failed or timed out while opening
     * ({@code type} {@link HttpDataSource.HttpDataSourceException#TYPE_OPEN}) and the stream
     * never got ready. Later failures (a hiccup mid-play) keep Media3's retries.
     */
    public static boolean giveUp(boolean everReady, int type, int reason) {
        if (everReady || type != HttpDataSource.HttpDataSourceException.TYPE_OPEN) return false;
        return reason == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || reason == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT;
    }
}
