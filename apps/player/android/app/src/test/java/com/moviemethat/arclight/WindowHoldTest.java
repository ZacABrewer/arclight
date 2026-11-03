package com.moviemethat.arclight;

import static org.junit.Assert.assertEquals;

import android.view.View;
import org.junit.Test;

public class WindowHoldTest {

    @Test
    public void heldReportsVisibleWhateverTheWindowIs() {
        assertEquals(View.VISIBLE, WindowHold.effective(View.GONE, true));
        assertEquals(View.VISIBLE, WindowHold.effective(View.INVISIBLE, true));
        assertEquals(View.VISIBLE, WindowHold.effective(View.VISIBLE, true));
    }

    @Test
    public void notHeldPassesTheRealVisibility() {
        assertEquals(View.GONE, WindowHold.effective(View.GONE, false));
        assertEquals(View.INVISIBLE, WindowHold.effective(View.INVISIBLE, false));
        assertEquals(View.VISIBLE, WindowHold.effective(View.VISIBLE, false));
    }
}
