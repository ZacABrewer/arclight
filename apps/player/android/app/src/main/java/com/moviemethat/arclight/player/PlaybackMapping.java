package com.moviemethat.arclight.player;

import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;

/**
 * Pure mapping rules between Media3 and the plugin contract (status names, error codes,
 * trackChanged reasons). Only compile-time constants from Media3 are used, so these are
 * plain JVM unit-testable.
 */
public final class PlaybackMapping {

    private PlaybackMapping() {}

    /**
     * The contract's PlaybackStatus for the player's state.
     *
     * @param everReady whether the current track reached READY since it was loaded (separates
     *     "loading" a new track from "buffering" mid-track)
     */
    public static String status(int playbackState, boolean playWhenReady, boolean hasError, boolean everReady, boolean hasItems, boolean suppressed) {
        if (hasError) return "error";
        if (!hasItems) return "idle";
        switch (playbackState) {
            case Player.STATE_IDLE:
                return "idle";
            case Player.STATE_BUFFERING:
                if (!everReady) return "loading";
                return playWhenReady ? "buffering" : "paused";
            case Player.STATE_READY:
                return playWhenReady && !suppressed ? "playing" : "paused";
            case Player.STATE_ENDED:
                return "ended";
            default:
                return "idle";
        }
    }

    /**
     * The contract's PlayerErrorCode for a Media3 error.
     *
     * @param httpStatus the HTTP status when the failure was a bad HTTP response, else 0
     * @param local the failing track is a downloaded file
     */
    public static String errorCode(int media3ErrorCode, int httpStatus, boolean local) {
        if (httpStatus > 0) {
            if (httpStatus == 401 || httpStatus == 403) return "auth";
            if (httpStatus == 429 || httpStatus == 503) return "busy";
            if (httpStatus >= 500) return "network";
            if (httpStatus == 415) return "unsupported";
            return "unknown";
        }
        switch (media3ErrorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
            case PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED:
            case PlaybackException.ERROR_CODE_TIMEOUT:
                return local ? "file" : "network";
            case PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND:
            case PlaybackException.ERROR_CODE_IO_NO_PERMISSION:
            case PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE:
            case PlaybackException.ERROR_CODE_IO_UNSPECIFIED:
                return local ? "file" : "network";
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS:
                return "network";
            case PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
            case PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED:
                return "unsupported";
            default:
                return "unknown";
        }
    }

    /** trackChanged.reason for a Media3 media item transition native did not start itself. */
    public static String transitionReason(int media3Reason) {
        switch (media3Reason) {
            case Player.MEDIA_ITEM_TRANSITION_REASON_AUTO:
            case Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT:
                return "auto";
            case Player.MEDIA_ITEM_TRANSITION_REASON_SEEK:
                return "skip";
            case Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED:
            default:
                return "load";
        }
    }

    /** Playback rate clamped to the contract's 0.5–3.5 range (NaN and 0 become 1). */
    public static float clampRate(double rate) {
        if (Double.isNaN(rate) || rate <= 0) return 1f;
        return (float) Math.min(3.5, Math.max(0.5, rate));
    }

    public static float clampVolume(double volume) {
        if (Double.isNaN(volume)) return 1f;
        return (float) Math.min(1.0, Math.max(0.0, volume));
    }

    /** Media3 repeat mode for the contract's RepeatMode. */
    public static int repeatMode(String mode) {
        if ("one".equals(mode)) return Player.REPEAT_MODE_ONE;
        if ("all".equals(mode)) return Player.REPEAT_MODE_ALL;
        return Player.REPEAT_MODE_OFF;
    }

    public static String repeatName(int media3Mode) {
        if (media3Mode == Player.REPEAT_MODE_ONE) return "one";
        if (media3Mode == Player.REPEAT_MODE_ALL) return "all";
        return "off";
    }
}
