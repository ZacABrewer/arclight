package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import org.json.JSONObject;

/**
 * The overlay's colours and radii (NativeVideoTheme), defaulting to the cinema palette. Colours
 * are ARGB ints parsed here (no android.graphics.Color, so it is JVM unit-testable). The theme
 * does not send text4 / line / panel / fill / track, so those are derived the way the template
 * derives them from bg and text.
 */
public final class OverlayTheme {

    public final int bg;
    public final int text;
    public final int text2;
    public final int text3;
    /** Section labels (AUDIO / SUBTITLES). */
    public final int text4;
    public final int accent;
    public final int primaryBg;
    public final int primaryText;
    /** Panel background: bg at .97. */
    public final int panel;
    /** Panel left border. */
    public final int line;
    /** Secondary buttons: text at .14. */
    public final int fill;
    /** Unselected chips: text at .08. */
    public final int chip;
    /** Scrub track: text at .25. */
    public final int track;
    /** Boxed certification border. */
    public final int certBorder;
    public final float radiusButton;
    public final float radiusTile;

    public static final OverlayTheme CINEMA = new OverlayTheme(null);

    public OverlayTheme(@Nullable JSONObject o) {
        bg = color(o, "bg", 0xFF111316);
        text = color(o, "text", 0xFFEEF1F4);
        text2 = color(o, "text2", 0xFFC3C9D1);
        text3 = color(o, "text3", 0xFFA9B1BB);
        accent = color(o, "accent", 0xFF6EF6FF);
        primaryBg = color(o, "primaryBg", 0xFFFFFFFF);
        primaryText = color(o, "primaryText", 0xFF111111);
        boolean custom = o != null && o.has("bg");
        // The cinema values from the template, exact; derived for other packs.
        text4 = custom ? mix(text3, bg, 0.3f) : 0xFF7D848E;
        line = custom ? mix(bg, text, 0.10f) : 0xFF262A30;
        certBorder = custom ? mix(text3, bg, 0.45f) : 0xFF5D646E;
        panel = alpha(bg, 0.97f);
        fill = alpha(0xFFFFFFFF, 0.14f);
        chip = alpha(0xFFFFFFFF, 0.08f);
        track = alpha(0xFFFFFFFF, 0.25f);
        radiusButton = radius(o, "radiusButton", 8);
        radiusTile = radius(o, "radiusTile", 8);
    }

    private static float radius(@Nullable JSONObject o, String key, float def) {
        if (o == null || !o.has(key)) return def;
        double d = o.optDouble(key, def);
        return Double.isNaN(d) || d < 0 ? def : (float) d;
    }

    private static int color(@Nullable JSONObject o, String key, int def) {
        if (o == null) return def;
        Integer c = parse(o.optString(key, ""));
        return c == null ? def : c;
    }

    /** "#rrggbb" / "#aarrggbb" (also "#rgb"); null when malformed. */
    @Nullable
    public static Integer parse(@Nullable String s) {
        if (s == null) return null;
        String h = s.trim();
        if (!h.startsWith("#")) return null;
        h = h.substring(1);
        if (h.length() == 3) h = "" + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        if (h.length() != 6 && h.length() != 8) return null;
        try {
            long v = Long.parseLong(h, 16);
            return h.length() == 6 ? (int) (0xFF000000L | v) : (int) v;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** {@code c} with its alpha replaced by {@code a} (0..1). */
    public static int alpha(int c, float a) {
        int al = Math.round(Math.max(0, Math.min(1, a)) * 255);
        return (al << 24) | (c & 0x00FFFFFF);
    }

    /** Opaque mix of {@code a} towards {@code b} by {@code t} (0 = a, 1 = b). */
    public static int mix(int a, int b, float t) {
        int r = Math.round(((a >> 16) & 0xFF) + (((b >> 16) & 0xFF) - ((a >> 16) & 0xFF)) * t);
        int g = Math.round(((a >> 8) & 0xFF) + (((b >> 8) & 0xFF) - ((a >> 8) & 0xFF)) * t);
        int bl = Math.round((a & 0xFF) + ((b & 0xFF) - (a & 0xFF)) * t);
        return 0xFF000000 | (r << 16) | (g << 8) | bl;
    }
}
