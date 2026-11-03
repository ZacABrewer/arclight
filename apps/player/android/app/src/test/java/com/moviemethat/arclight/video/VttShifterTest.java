package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VttShifterTest {

    private static final String VTT = "WEBVTT\n\n"
            + "NOTE a comment\n\n"
            + "1\n00:00:01.000 --> 00:00:04.000\nGone\n\n"
            + "2\n00:00:09.000 --> 00:00:12.500 align:start\nStraddles\n\n"
            + "00:01:00.000 --> 00:01:02.000\n<00:01:00.500>Karaoke <00:01:01.000>line\n";

    @Test
    public void zeroOffsetIsUnchanged() {
        assertSame(VTT, VttShifter.shift(VTT, 0));
    }

    @Test
    public void shiftsDropsAndClamps() {
        String out = VttShifter.shift(VTT, 10_000);
        assertTrue(out.startsWith("WEBVTT\n\nNOTE a comment\n\n"));
        assertFalse(out.contains("Gone"));
        assertTrue(out.contains("2\n00:00:00.000 --> 00:00:02.500 align:start\nStraddles"));
        assertTrue(out.contains("00:00:50.000 --> 00:00:52.000\n<00:00:50.500>Karaoke <00:00:51.000>line"));
    }

    @Test
    public void handlesCrlfBomAndShortTimes() {
        String in = "﻿WEBVTT\r\n\r\n01:05.250 --> 01:07.000\r\nHi\r\n";
        assertEquals("WEBVTT\n\n00:00:05.250 --> 00:00:07.000\nHi\n", VttShifter.shift(in, 60_000));
    }

    @Test
    public void parseAndFormat() {
        assertEquals(3_723_450, VttShifter.parse("01:02:03.450"));
        assertEquals(123_450, VttShifter.parse("02:03,45"));
        assertEquals(500, VttShifter.parse("00:00.5"));
        assertEquals("01:02:03.450", VttShifter.format(3_723_450));
        assertEquals("00:00:00.000", VttShifter.format(0));
    }
}
