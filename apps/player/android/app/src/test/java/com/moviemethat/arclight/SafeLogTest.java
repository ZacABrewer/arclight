package com.moviemethat.arclight;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class SafeLogTest {

    @Test
    public void redactsSignedLinkSignature() {
        String url = "https://media.example.com/api/v1/stream/42?u=7&exp=1999999999&sig=abcDEF123_-";
        assertEquals(
                "https://media.example.com/api/v1/stream/42?u=7&exp=1999999999&sig=REDACTED",
                SafeLog.redact(url));
    }

    @Test
    public void redactsTokensInsideExceptionText() {
        String text = "Source error: Response code 403 for http://media.example.com:8080/x?token=s3cret&b=1 (retry)";
        String out = SafeLog.redact(text);
        assertFalse(out.contains("s3cret"));
        assertEquals("Source error: Response code 403 for http://media.example.com:8080/x?token=REDACTED&b=1 (retry)", out);
    }

    @Test
    public void redactsCaseInsensitiveAndBearer() {
        assertEquals("a?API_KEY=REDACTED", SafeLog.redact("a?API_KEY=zzz"));
        assertEquals("Authorization: Bearer REDACTED", SafeLog.redact("Authorization: Bearer alt_abc.def"));
    }

    @Test
    public void leavesOrdinaryTextAlone() {
        String text = "Playback failed (2001) at ?u=7&exp=5 with monkey=1";
        assertEquals(text, SafeLog.redact(text));
        assertEquals("", SafeLog.redact(null));
    }
}
