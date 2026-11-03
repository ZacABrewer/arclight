package com.moviemethat.arclight.player;

import org.json.JSONObject;

/**
 * Where native events go: the live Capacitor plugin instance (null while the activity, and with
 * it the WebView, is gone; the service keeps playing without it).
 */
public interface EventSink {

    /**
     * Fires a plugin event.
     *
     * @param retain keep it until a listener is attached (trackChanged, downloadCompleted,
     *     downloadFailed), Capacitor's retainUntilConsumed
     */
    void emit(String event, JSONObject data, boolean retain);

    /** Whether JS currently listens to {@code event} (used to decide if JS can answer the car). */
    boolean hasListenersFor(String event);
}
