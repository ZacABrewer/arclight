package com.moviemethat.arclight.player;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSourceBitmapLoader;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import com.moviemethat.arclight.MainActivity;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.car.CarLibrary;
import com.moviemethat.arclight.car.CarLibraryCallback;

/**
 * Background playback: a Media3 MediaLibraryService (foregroundServiceType mediaPlayback) that
 * wraps {@link PlaybackHub}'s player in a MediaLibrarySession. Media3 posts the media
 * notification, keeps the service in the foreground while playing, and exposes the session to
 * the lock screen, Bluetooth / wired headsets, watches and Android Auto (browse tree via
 * {@link CarLibraryCallback}). Audio focus and "becoming noisy" are handled by the player.
 */
@UnstableApi
public final class PlaybackService extends MediaLibraryService {

    @Nullable private MediaLibrarySession session;

    @Override
    public void onCreate() {
        super.onCreate();
        PlaybackHub hub = PlaybackHub.get(this);
        Player player = hub.sessionPlayer();

        Intent open = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                // Tells a notification / lock-screen tap apart from the launcher (LaunchInfo).
                .putExtra(com.moviemethat.arclight.LaunchInfo.EXTRA_SOURCE, "notification");
        PendingIntent sessionActivity = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        session = new MediaLibrarySession.Builder(this, player, new CarLibraryCallback(hub, CarLibrary.get(this)))
                .setId("arclight")
                .setSessionActivity(sessionActivity)
                // Artwork for the notification / lock screen / car with the same per-URL headers as audio.
                .setBitmapLoader(new DataSourceBitmapLoader(DataSourceBitmapLoader.DEFAULT_EXECUTOR_SERVICE.get(), hub.dataSourceFactory()))
                .build();
        hub.attachSession(session);

        DefaultMediaNotificationProvider notifications = new DefaultMediaNotificationProvider.Builder(this).build();
        notifications.setSmallIcon(R.drawable.ic_stat_arclight);
        setMediaNotificationProvider(notifications);
    }

    @Nullable
    @Override
    public MediaLibrarySession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onDestroy() {
        PlaybackHub hub = PlaybackHub.get(this);
        if (session != null) {
            hub.detachSession(session);
            session.release();
            session = null;
        }
        hub.releasePlayer();
        super.onDestroy();
    }
}
