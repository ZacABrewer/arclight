package com.moviemethat.arclight;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.moviemethat.arclight.video.VideoProfile;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugin (not an npm package), registered before the bridge is created.
        registerPlugin(ArclightPlayerPlugin.class);
        Intent intent = getIntent();
        if (intent != null) {
            LaunchInfo.record(LaunchInfo.classify(intent.getAction(), intent.getCategories(), intent.getData() != null,
                    intent.getStringExtra(LaunchInfo.EXTRA_SOURCE), savedInstanceState != null));
        }
        super.onCreate(savedInstanceState);
        if (getBridge() != null) getBridge().setWebViewClient(new ArtworkProxy(getBridge()));
        if (VideoProfile.isTv(this)) prepareForRemote();
    }

    /**
     * Google TV / Android TV: the web UI does its own spatial navigation, so the WebView holds
     * focus (arrow keys reach JS as ArrowUp / ArrowDown / ...) and the system focus highlight
     * around the whole WebView is off. Back goes through the App plugin's backButton event.
     */
    private void prepareForRemote() {
        if (getBridge() == null) return;
        WebView web = getBridge().getWebView();
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        if (Build.VERSION.SDK_INT >= 26) web.setDefaultFocusHighlightEnabled(false);
        web.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // The remote's OK button is Enter for the web UI (WebView versions differ in mapping it).
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER && getBridge() != null && getBridge().getWebView().hasFocus()) {
            KeyEvent enter = new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(), KeyEvent.KEYCODE_ENTER,
                    event.getRepeatCount(), event.getMetaState(), event.getDeviceId(), event.getScanCode(), event.getFlags(),
                    event.getSource());
            return super.dispatchKeyEvent(enter);
        }
        return super.dispatchKeyEvent(event);
    }
}
