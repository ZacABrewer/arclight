package com.moviemethat.arclight.video;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Moves every cue of a WebVTT file earlier by a fixed offset. The server's subtitle files are
 * in media time; a remuxed / transcoded stream starts at {@code streamStartMs}, so its time 0 is
 * media time {@code streamStartMs} and cues must be shifted by that much to line up. Cues that
 * end before the stream starts are dropped; one that straddles the start is clamped to 0.
 * Header blocks (WEBVTT, STYLE, REGION, NOTE) pass through unchanged. Pure Java.
 */
public final class VttShifter {

    private VttShifter() {}

    private static final Pattern TIMING = Pattern.compile(
            "^\\s*((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})\\s+-->\\s+((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})(.*)$");
    /** Karaoke-style inline timestamps inside cue text: {@code <00:01:02.500>}. */
    private static final Pattern INLINE = Pattern.compile("<((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})>");

    /** Returns {@code vtt} with every time reduced by {@code offsetMs} (no-op when {@code offsetMs <= 0}). */
    public static String shift(String vtt, long offsetMs) {
        if (vtt == null) return "";
        if (offsetMs <= 0) return vtt;
        String text = vtt.startsWith("﻿") ? vtt.substring(1) : vtt;
        String[] blocks = text.replace("\r\n", "\n").replace('\r', '\n').replaceAll("\\s+$", "").split("\n[ \t]*\n");
        StringBuilder out = new StringBuilder(text.length());
        for (String block : blocks) {
            if (block.trim().isEmpty()) continue;
            String shifted = shiftBlock(block, offsetMs);
            if (shifted == null) continue;
            if (out.length() > 0) out.append("\n\n");
            out.append(shifted);
        }
        out.append('\n');
        return out.toString();
    }

    /** One block: a cue (shifted, or null when it ends before 0) or a header block (unchanged). */
    private static String shiftBlock(String block, long offsetMs) {
        String[] lines = block.split("\n", -1);
        int timingLine = -1;
        Matcher m = null;
        // The timing line is the first line, or the second when the cue has an identifier.
        for (int i = 0; i < Math.min(2, lines.length); i++) {
            Matcher candidate = TIMING.matcher(lines[i]);
            if (candidate.matches()) {
                timingLine = i;
                m = candidate;
                break;
            }
        }
        if (m == null) return block;
        long start = parse(m.group(1)) - offsetMs;
        long end = parse(m.group(2)) - offsetMs;
        if (end <= 0) return null;
        lines[timingLine] = format(Math.max(0, start)) + " --> " + format(end) + m.group(3);
        for (int i = timingLine + 1; i < lines.length; i++) {
            if (lines[i].indexOf('<') >= 0) lines[i] = shiftInline(lines[i], offsetMs);
        }
        return String.join("\n", lines);
    }

    private static String shiftInline(String line, long offsetMs) {
        Matcher m = INLINE.matcher(line);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            long t = Math.max(0, parse(m.group(1)) - offsetMs);
            m.appendReplacement(sb, Matcher.quoteReplacement("<" + format(t) + ">"));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** "01:02:03.450", "02:03.450" (and a comma decimal from SRT-ish files) to ms. */
    static long parse(String ts) {
        String t = ts.trim().replace(',', '.');
        int dot = t.lastIndexOf('.');
        String frac = dot >= 0 ? t.substring(dot + 1) : "0";
        String whole = dot >= 0 ? t.substring(0, dot) : t;
        String[] parts = whole.split(":");
        long h = 0;
        long min;
        long sec;
        if (parts.length == 3) {
            h = Long.parseLong(parts[0]);
            min = Long.parseLong(parts[1]);
            sec = Long.parseLong(parts[2]);
        } else {
            min = Long.parseLong(parts[0]);
            sec = Long.parseLong(parts[1]);
        }
        // "5" = 500 ms, "05" = 50 ms, "005" = 5 ms.
        while (frac.length() < 3) frac = frac + "0";
        long ms = Long.parseLong(frac.substring(0, 3));
        return ((h * 60 + min) * 60 + sec) * 1000 + ms;
    }

    static String format(long ms) {
        long h = ms / 3_600_000;
        long m = (ms / 60_000) % 60;
        long s = (ms / 1000) % 60;
        long f = ms % 1000;
        return String.format(java.util.Locale.ROOT, "%02d:%02d:%02d.%03d", h, m, s, f);
    }
}
