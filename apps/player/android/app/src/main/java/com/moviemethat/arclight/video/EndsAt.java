package com.moviemethat.arclight.video;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * The pause screen's "Ends at 9:42 PM": device clock now + the remaining time at normal speed,
 * in the device's 12 / 24 h setting. Pure (time zone, locale and the 24 h flag are passed in).
 */
public final class EndsAt {

    private EndsAt() {}

    /** The clock time, e.g. "9:42 PM" or "21:42". */
    public static String format(long nowMs, long remainingMs, TimeZone zone, Locale locale, boolean is24h) {
        SimpleDateFormat f = new SimpleDateFormat(is24h ? "H:mm" : "h:mm a", locale);
        f.setTimeZone(zone);
        return f.format(new Date(nowMs + Math.max(0, remainingMs)));
    }
}
