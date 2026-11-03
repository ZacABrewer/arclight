package com.moviemethat.arclight.cast;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;
import com.google.android.gms.cast.framework.media.CastMediaOptions;
import com.google.android.gms.cast.framework.media.NotificationOptions;
import com.moviemethat.arclight.MainActivity;
import com.moviemethat.arclight.R;
import java.util.List;

/**
 * Google Cast configuration (read by the Cast framework through the manifest's
 * OPTIONS_PROVIDER_CLASS_NAME). Uses Google's Default Media Receiver, which plays the signed
 * stream links JS hands over; no custom receiver app is needed.
 */
public final class CastOptionsProvider implements OptionsProvider {

    @NonNull
    @Override
    public CastOptions getCastOptions(@NonNull Context context) {
        NotificationOptions notification = new NotificationOptions.Builder()
                .setTargetActivityClassName(MainActivity.class.getName())
                .setSmallIconDrawableResId(R.drawable.ic_stat_arclight)
                .build();
        CastMediaOptions media = new CastMediaOptions.Builder()
                .setNotificationOptions(notification)
                .build();
        return new CastOptions.Builder()
                .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
                .setCastMediaOptions(media)
                .setStopReceiverApplicationWhenEndingSession(true)
                .build();
    }

    @Nullable
    @Override
    public List<SessionProvider> getAdditionalSessionProviders(@NonNull Context context) {
        return null;
    }
}
