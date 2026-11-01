package com.moviemethat.arclight;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugin (not an npm package), registered before the bridge is created.
        registerPlugin(ArclightNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
