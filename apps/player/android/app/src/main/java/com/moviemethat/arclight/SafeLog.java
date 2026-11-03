package com.moviemethat.arclight;

import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import java.util.regex.Pattern;

/**
 * Logcat without secrets. Stream, artwork and download URLs carry a signature (`sig=`) or a
 * token that opens the user's media, and exception messages repeat those URLs; every log line
 * of the app (ours and Media3's) goes through {@link #redact} first, in release builds too.
 */
public final class SafeLog {

    /** Query parameters whose value is a secret. */
    private static final Pattern SECRET_PARAM = Pattern.compile(
            "([?&;](?:sig|signature|token|access_token|refresh_token|api_key|apikey|key|auth|password|x-plex-token|x-emby-token|x-amz-signature|x-amz-credential)=)[^&#\\s\"'<>]*",
            Pattern.CASE_INSENSITIVE);
    /** Authorization header values ("Bearer alt_..."). */
    private static final Pattern BEARER = Pattern.compile("(Bearer\\s+)[A-Za-z0-9._~+/=-]+", Pattern.CASE_INSENSITIVE);
    static final String REDACTED = "REDACTED";

    private static volatile boolean installed;

    private SafeLog() {}

    /** {@code text} with secret query values and bearer tokens replaced. Pure (tests). */
    public static String redact(@Nullable String text) {
        if (text == null || text.isEmpty()) return text == null ? "" : text;
        String out = SECRET_PARAM.matcher(text).replaceAll("$1" + REDACTED);
        return BEARER.matcher(out).replaceAll("$1" + REDACTED);
    }

    private static String line(String message, @Nullable Throwable t) {
        return redact(t == null ? message : message + "\n" + Log.getStackTraceString(t));
    }

    public static void d(String tag, String message) {
        Log.d(tag, redact(message));
    }

    public static void i(String tag, String message) {
        Log.i(tag, redact(message));
    }

    public static void w(String tag, String message) {
        Log.w(tag, redact(message));
    }

    public static void w(String tag, String message, @Nullable Throwable t) {
        Log.w(tag, line(message, t));
    }

    public static void e(String tag, String message) {
        Log.e(tag, redact(message));
    }

    public static void e(String tag, String message, @Nullable Throwable t) {
        Log.e(tag, line(message, t));
    }

    /** Sends Media3's own logging (its playback errors print the failing URL) through {@link #redact}. Idempotent. */
    @UnstableApi
    public static void install() {
        if (installed) return;
        installed = true;
        androidx.media3.common.util.Log.setLogger(new androidx.media3.common.util.Log.Logger() {
            @Override
            public void d(String tag, String message, @Nullable Throwable t) {
                Log.d(tag, line(message, t));
            }

            @Override
            public void i(String tag, String message, @Nullable Throwable t) {
                Log.i(tag, line(message, t));
            }

            @Override
            public void w(String tag, String message, @Nullable Throwable t) {
                Log.w(tag, line(message, t));
            }

            @Override
            public void e(String tag, String message, @Nullable Throwable t) {
                Log.e(tag, line(message, t));
            }
        });
    }
}
