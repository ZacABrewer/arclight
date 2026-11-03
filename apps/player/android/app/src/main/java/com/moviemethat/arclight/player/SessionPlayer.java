package com.moviemethat.arclight.player;

import androidx.annotation.NonNull;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import java.util.List;

/**
 * The player the MediaSession sees. Every call on it comes from a media controller (the media
 * notification, the lock screen, headset buttons, a watch, Android Auto), never from the app's
 * JS, which drives {@link PlaybackHub} directly. Overriding these calls is how native applies
 * remote commands itself and reports them to JS ({@code remoteCommand}), and how next/previous
 * are left to JS first, per the plugin contract.
 */
final class SessionPlayer extends ForwardingPlayer {

    private final PlaybackHub hub;

    SessionPlayer(Player player, PlaybackHub hub) {
        super(player);
        this.hub = hub;
    }

    // ---- play / pause / stop -------------------------------------------------------------

    @Override
    public void play() {
        if (hub.remotePlay()) super.play();
    }

    @Override
    public void pause() {
        if (hub.remotePause()) super.pause();
    }

    @Override
    public void setPlayWhenReady(boolean playWhenReady) {
        if (playWhenReady) play();
        else pause();
    }

    @Override
    public void stop() {
        hub.remoteStop();
    }

    // ---- seeking ---------------------------------------------------------------------------

    @Override
    public void seekTo(long positionMs) {
        hub.remoteSeekTo(positionMs);
    }

    @Override
    public void seekBack() {
        hub.remoteSkip(false);
    }

    @Override
    public void seekForward() {
        hub.remoteSkip(true);
    }

    @Override
    public long getSeekBackIncrement() {
        return hub.skipBackMs();
    }

    @Override
    public long getSeekForwardIncrement() {
        return hub.skipForwardMs();
    }

    // ---- next / previous: JS decides, native falls back after 2 s -------------------------

    @Override
    public void seekToNext() {
        hub.remoteNext();
    }

    @Override
    public void seekToNextMediaItem() {
        hub.remoteNext();
    }

    @Override
    public void seekToPrevious() {
        hub.remotePrevious();
    }

    @Override
    public void seekToPreviousMediaItem() {
        hub.remotePrevious();
    }

    @Override
    public void seekTo(int mediaItemIndex, long positionMs) {
        // A car queue view picking a row of the native queue.
        hub.remoteSkipTo(mediaItemIndex, positionMs);
    }

    // ---- items from the car browser: JS builds the real queue ----------------------------

    @Override
    public void setMediaItems(@NonNull List<MediaItem> mediaItems, boolean resetPosition) {
        if (PlaybackHub.isPlaceholder(mediaItems)) return;
        hub.adoptControllerItems(mediaItems);
        super.setMediaItems(mediaItems, resetPosition);
    }

    @Override
    public void setMediaItems(@NonNull List<MediaItem> mediaItems, int startIndex, long startPositionMs) {
        if (PlaybackHub.isPlaceholder(mediaItems)) return;
        hub.adoptControllerItems(mediaItems);
        super.setMediaItems(mediaItems, startIndex, startPositionMs);
    }

    @Override
    public void setMediaItems(@NonNull List<MediaItem> mediaItems) {
        if (PlaybackHub.isPlaceholder(mediaItems)) return;
        hub.adoptControllerItems(mediaItems);
        super.setMediaItems(mediaItems);
    }

    @Override
    public void addMediaItems(@NonNull List<MediaItem> mediaItems) {
        if (PlaybackHub.isPlaceholder(mediaItems)) return;
        // Controllers may not grow the JS-owned queue.
    }

    @Override
    public void addMediaItems(int index, @NonNull List<MediaItem> mediaItems) {
        if (PlaybackHub.isPlaceholder(mediaItems)) return;
    }
}
