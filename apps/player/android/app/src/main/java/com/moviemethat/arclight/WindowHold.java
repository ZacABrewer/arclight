package com.moviemethat.arclight;

import android.view.View;

/**
 * The window visibility the app's WebView reports to its page while the native video screen is
 * in front. That screen covers MainActivity, so the page goes hidden; after five hidden minutes
 * the WebView stops the page's tasks and the player's events (progress, seek requests, track
 * changes) no longer reach JS. While the video screen is started the page counts as visible.
 */
final class WindowHold {

    private WindowHold() {}

    /** What the WebView is told: visible while held, otherwise the window's real visibility. */
    static int effective(int realVisibility, boolean held) {
        return held ? View.VISIBLE : realVisibility;
    }
}
