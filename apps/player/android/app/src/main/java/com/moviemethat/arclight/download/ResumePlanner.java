package com.moviemethat.arclight.download;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides what to do with a download response, given how many bytes of the partial file are
 * already on disk (the resume bookkeeping). Pure Java (unit tested).
 *
 * <p>The worker asks with {@code Range: bytes=<partial>-} (plus {@code If-Range} with the
 * validator it saw first) whenever a partial file exists.
 */
public final class ResumePlanner {

    public enum Action {
        /** Append the body to the partial file. */
        APPEND,
        /** The server sent the whole file: truncate the partial file and write from byte 0. */
        RESTART,
        /** The partial file already holds the whole file (416 with a matching length). */
        COMPLETE,
        /** Throw the partial file away and ask again without Range (bad 206 / 416). */
        DISCARD_AND_RETRY,
        /** Give up; retrying will not help (401, 403, 404, 410, other 4xx). */
        FAIL_PERMANENT,
        /** Try again later (5xx, 408, 429, unexpected statuses). */
        FAIL_RETRY,
    }

    public static final class Decision {
        public final Action action;
        /** Expected size of the complete file, -1 when unknown. */
        public final long totalBytes;

        Decision(Action action, long totalBytes) {
            this.action = action;
            this.totalBytes = totalBytes;
        }

        @Override
        public String toString() {
            return action + "/" + totalBytes;
        }
    }

    private static final Pattern CONTENT_RANGE = Pattern.compile("^\\s*bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)\\s*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern UNSATISFIED_RANGE = Pattern.compile("^\\s*bytes\\s+\\*/(\\d+)\\s*$", Pattern.CASE_INSENSITIVE);

    private ResumePlanner() {}

    /** The Range header value for a partial file, or null when starting from scratch. */
    public static String rangeHeader(long partialBytes) {
        return partialBytes > 0 ? "bytes=" + partialBytes + "-" : null;
    }

    /**
     * @param partialBytes bytes already on disk (the Range start that was requested; 0 = none)
     * @param status HTTP status
     * @param contentRange the Content-Range header, or null
     * @param contentLength the Content-Length header (-1 when absent)
     */
    public static Decision decide(long partialBytes, int status, String contentRange, long contentLength) {
        if (status == 206) {
            Matcher m = contentRange == null ? null : CONTENT_RANGE.matcher(contentRange);
            if (m == null || !m.matches()) return new Decision(Action.DISCARD_AND_RETRY, -1);
            long start = Long.parseLong(m.group(1));
            long total = "*".equals(m.group(3)) ? -1 : Long.parseLong(m.group(3));
            if (start != partialBytes) return new Decision(Action.DISCARD_AND_RETRY, total);
            return new Decision(Action.APPEND, total);
        }
        if (status >= 200 && status < 300) {
            return new Decision(Action.RESTART, contentLength >= 0 ? contentLength : -1);
        }
        if (status == 416) {
            if (partialBytes > 0 && contentRange != null) {
                Matcher m = UNSATISFIED_RANGE.matcher(contentRange);
                if (m.matches() && Long.parseLong(m.group(1)) == partialBytes) {
                    return new Decision(Action.COMPLETE, partialBytes);
                }
            }
            return new Decision(Action.DISCARD_AND_RETRY, -1);
        }
        if (status == 408 || status == 429 || status >= 500) return new Decision(Action.FAIL_RETRY, -1);
        if (status >= 400) return new Decision(Action.FAIL_PERMANENT, -1);
        return new Decision(Action.FAIL_RETRY, -1);
    }

    /** Whether a finished download has the expected length (unknown totals always pass). */
    public static boolean lengthMatches(long written, long totalBytes) {
        return totalBytes < 0 || written == totalBytes;
    }
}
