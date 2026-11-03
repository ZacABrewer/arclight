package com.moviemethat.arclight.car;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService.LibraryParams;
import androidx.media3.session.MediaLibraryService.MediaLibrarySession;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionError;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import com.moviemethat.arclight.player.PlaybackHub;
import java.util.Arrays;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The MediaLibrarySession callback: connection rules for every controller (notification, lock
 * screen, Bluetooth, Android Auto), the car browse tree and search, the car's "play this", and
 * playback resumption.
 */
@UnstableApi
public final class CarLibraryCallback implements MediaLibrarySession.Callback {

    private final PlaybackHub hub;
    private final CarLibrary car;

    public CarLibraryCallback(PlaybackHub hub, CarLibrary car) {
        this.hub = hub;
        this.car = car;
    }

    // ---- connections ------------------------------------------------------------------

    @NonNull
    @Override
    public MediaSession.ConnectionResult onConnect(@NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller) {
        String pkg = controller.getPackageName();
        ControllerPolicy.Access access = ControllerPolicy.decide(pkg, controller.getUid(), hub.context().getPackageName(),
                controller.isTrusted(), ControllerPolicy.isCarHost(pkg) && isGenuinePackage(pkg, controller.getUid()));
        if (access == ControllerPolicy.Access.REJECT) return MediaSession.ConnectionResult.reject();
        if (CarLibrary.isCarPackage(pkg)) car.carConnected(true);
        return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(access == ControllerPolicy.Access.FULL
                        ? MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
                        : MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS)
                .setAvailablePlayerCommands(hub.allowedPlayerCommands())
                .setMediaButtonPreferences(hub.mediaButtons())
                .build();
    }

    @Override
    public void onDisconnected(@NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller) {
        if (CarLibrary.isCarPackage(controller.getPackageName())) car.carConnected(false);
    }

    /**
     * The package really runs as this uid and is the system's copy or Google Play's (an app
     * sideloaded under a car host's package name is neither).
     */
    private boolean isGenuinePackage(String pkg, int uid) {
        PackageManager pm = hub.context().getPackageManager();
        try {
            String[] forUid = pm.getPackagesForUid(uid);
            if (forUid == null || !Arrays.asList(forUid).contains(pkg)) return false;
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            if ((info.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0) return true;
            String installer = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? pm.getInstallSourceInfo(pkg).getInstallingPackageName()
                    : pm.getInstallerPackageName(pkg);
            return PLAY_STORE.equals(installer);
        } catch (PackageManager.NameNotFoundException | SecurityException e) {
            return false;
        }
    }

    private static final String PLAY_STORE = "com.android.vending";

    // ---- browsing ---------------------------------------------------------------------

    @NonNull
    @Override
    public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(@NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser, @Nullable LibraryParams params) {
        Bundle extras = new Bundle();
        extras.putBoolean(CarLibrary.EXTRA_SEARCH_SUPPORTED, true);
        LibraryParams rootParams = new LibraryParams.Builder().setExtras(extras).build();
        return Futures.immediateFuture(LibraryResult.ofItem(car.rootItem(), rootParams));
    }

    @NonNull
    @Override
    public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(@NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser, @NonNull String parentId, int page, int pageSize,
            @Nullable LibraryParams params) {
        final String grantTo = browser.getPackageName();
        return Futures.transform(car.broker().children(parentId), nodes -> {
            if (nodes.isEmpty() && BrowseCache.ROOT_ID.equals(parentId)) nodes = car.defaultRoot();
            List<BrowseNodeInfo> slice = BrowseCache.page(nodes, page, pageSize);
            return LibraryResult.ofItemList(ImmutableList.copyOf(car.toMediaItems(slice, grantTo)), params);
        }, MoreExecutors.directExecutor());
    }

    @NonNull
    @Override
    public ListenableFuture<LibraryResult<MediaItem>> onGetItem(@NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser, @NonNull String mediaId) {
        if (BrowseCache.ROOT_ID.equals(mediaId)) return Futures.immediateFuture(LibraryResult.ofItem(car.rootItem(), null));
        BrowseNodeInfo n = car.broker().cache().find(mediaId);
        if (n == null) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_BAD_VALUE));
        return Futures.immediateFuture(LibraryResult.ofItem(car.toMediaItem(n, browser.getPackageName()), null));
    }

    // ---- search -----------------------------------------------------------------------

    @NonNull
    @Override
    public ListenableFuture<LibraryResult<Void>> onSearch(@NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser, @NonNull String query, @Nullable LibraryParams params) {
        Futures.addCallback(car.broker().search(query), new FutureCallback<List<BrowseNodeInfo>>() {
            @Override
            public void onSuccess(List<BrowseNodeInfo> result) {
                car.putSearchResults(query, result);
                session.notifySearchResultChanged(browser, query, result.size(), params);
            }

            @Override
            public void onFailure(@NonNull Throwable t) {
                car.putSearchResults(query, ImmutableList.of());
                session.notifySearchResultChanged(browser, query, 0, params);
            }
        }, ContextCompat.getMainExecutor(hub.context()));
        return Futures.immediateFuture(LibraryResult.ofVoid());
    }

    @NonNull
    @Override
    public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(@NonNull MediaLibrarySession session,
            @NonNull MediaSession.ControllerInfo browser, @NonNull String query, int page, int pageSize,
            @Nullable LibraryParams params) {
        List<BrowseNodeInfo> nodes = car.searchResults(query);
        if (nodes == null) nodes = car.broker().cache().search(query, 50);
        List<BrowseNodeInfo> slice = BrowseCache.page(nodes, page, pageSize);
        return Futures.immediateFuture(LibraryResult.ofItemList(
                ImmutableList.copyOf(car.toMediaItems(slice, browser.getPackageName())), params));
    }

    // ---- the car picked something to play -----------------------------------------------

    @NonNull
    @Override
    public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(@NonNull MediaSession session,
            @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems, int startIndex,
            long startPositionMs) {
        if (mediaItems.isEmpty()) {
            return Futures.immediateFailedFuture(new IllegalArgumentException("Nothing to play"));
        }
        MediaItem picked = mediaItems.get(startIndex == C.INDEX_UNSET || startIndex >= mediaItems.size() ? 0 : Math.max(0, startIndex));
        if (!hub.jsListens("browsePlay")) {
            // Only JS can turn a node into stream links; the phone app has to be running.
            return Futures.immediateFailedFuture(new IllegalStateException("Open Arclight on the phone to start playback"));
        }
        String query = picked.requestMetadata.searchQuery;
        if (picked.mediaId.isEmpty() && query != null) {
            playFromSearch(query);
        } else {
            requestPlay(picked.mediaId, car.broker().cache().parentOf(picked.mediaId));
        }
        hub.expectJsLoad();
        return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(PlaybackHub.placeholder(), 0, 0));
    }

    @NonNull
    @Override
    public ListenableFuture<List<MediaItem>> onAddMediaItems(@NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
        // Adding to the JS-owned queue is not offered; picking an item goes through onSetMediaItems.
        return Futures.immediateFailedFuture(new UnsupportedOperationException("Queue edits are made in the app"));
    }

    private void playFromSearch(String query) {
        Futures.addCallback(car.broker().search(query), new FutureCallback<List<BrowseNodeInfo>>() {
            @Override
            public void onSuccess(List<BrowseNodeInfo> result) {
                for (BrowseNodeInfo n : result) {
                    if (n.playable) {
                        requestPlay(n.id, null);
                        return;
                    }
                }
            }

            @Override
            public void onFailure(@NonNull Throwable t) {}
        }, ContextCompat.getMainExecutor(hub.context()));
    }

    private void requestPlay(String nodeId, @Nullable String parentId) {
        JSONObject o = new JSONObject();
        try {
            o.put("nodeId", nodeId);
            if (parentId != null) o.put("parentId", parentId);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        hub.emit("browsePlay", o, true);
    }

    // ---- playback resumption (headset / car "play" after the process died) ---------------

    @NonNull
    @Override
    public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(@NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller) {
        MediaSession.MediaItemsWithStartPosition items = hub.resumptionItems();
        if (items == null) return Futures.immediateFailedFuture(new IllegalStateException("Nothing to resume"));
        return Futures.immediateFuture(items);
    }
}
