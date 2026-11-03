package com.moviemethat.arclight;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native side of the "ArclightPlayer" Capacitor plugin.
 *
 * The contract (methods, options, results and events) is
 * apps/player/src/native/definitions.ts. This class is a stub: every method rejects with
 * UNIMPLEMENTED, and the app then falls back to its in-WebView HTMLAudioElement engine (no
 * background playback, no downloads, no Android Auto, no cast).
 *
 * The real implementation (Media3 ExoPlayer + MediaSessionService, a download worker, the
 * Android Auto MediaLibraryService, Cast) replaces these bodies without changing the method
 * names, which must stay in sync with definitions.ts.
 */
@CapacitorPlugin(name = "ArclightPlayer")
public class ArclightPlayerPlugin extends Plugin {

    private void todo(PluginCall call) {
        call.unimplemented("ArclightPlayer." + call.getMethodName() + " is not implemented on Android yet.");
    }

    // Info
    @PluginMethod public void getInfo(PluginCall call) { todo(call); }

    // Audio
    @PluginMethod public void load(PluginCall call) { todo(call); }
    @PluginMethod public void setUpcoming(PluginCall call) { todo(call); }
    @PluginMethod public void play(PluginCall call) { todo(call); }
    @PluginMethod public void pause(PluginCall call) { todo(call); }
    @PluginMethod public void seek(PluginCall call) { todo(call); }
    @PluginMethod public void skipTo(PluginCall call) { todo(call); }
    @PluginMethod public void setRate(PluginCall call) { todo(call); }
    @PluginMethod public void setVolume(PluginCall call) { todo(call); }
    @PluginMethod public void setRepeat(PluginCall call) { todo(call); }
    @PluginMethod public void setShuffle(PluginCall call) { todo(call); }
    @PluginMethod public void stop(PluginCall call) { todo(call); }
    @PluginMethod public void getState(PluginCall call) { todo(call); }
    @PluginMethod public void configureRemote(PluginCall call) { todo(call); }
    @PluginMethod public void setNowPlayingExtra(PluginCall call) { todo(call); }
    @PluginMethod public void setSleepTimer(PluginCall call) { todo(call); }

    // Downloads
    @PluginMethod public void enqueueDownload(PluginCall call) { todo(call); }
    @PluginMethod public void pauseDownload(PluginCall call) { todo(call); }
    @PluginMethod public void resumeDownload(PluginCall call) { todo(call); }
    @PluginMethod public void cancelDownload(PluginCall call) { todo(call); }
    @PluginMethod public void listDownloads(PluginCall call) { todo(call); }
    @PluginMethod public void deleteDownload(PluginCall call) { todo(call); }
    @PluginMethod public void getStorageInfo(PluginCall call) { todo(call); }
    @PluginMethod public void setDownloadPolicy(PluginCall call) { todo(call); }

    // Car (Android Auto)
    @PluginMethod public void setBrowseTree(PluginCall call) { todo(call); }
    @PluginMethod public void answerBrowse(PluginCall call) { todo(call); }

    // Cast
    @PluginMethod public void getCastState(PluginCall call) { todo(call); }
    @PluginMethod public void showRoutePicker(PluginCall call) { todo(call); }
    @PluginMethod public void endCastSession(PluginCall call) { todo(call); }
}
