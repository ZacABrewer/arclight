package com.moviemethat.arclight;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import androidx.annotation.MainThread;
import com.getcapacitor.CapacitorWebView;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Capacitor's WebView (res/layout/capacitor_bridge_layout_main.xml) that keeps its page running
 * while the native video screen covers it: see {@link WindowHold}.
 */
public class ArclightWebView extends CapacitorWebView {

    private static final Set<ArclightWebView> LIVE = Collections.newSetFromMap(new WeakHashMap<>());
    private static boolean held;

    private int realWindowVisibility = View.VISIBLE;

    public ArclightWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        LIVE.add(this);
    }

    /** The video screen started (true) or stopped (false). */
    @MainThread
    public static void holdVisible(boolean on) {
        if (held == on) return;
        held = on;
        for (ArclightWebView w : LIVE.toArray(new ArclightWebView[0])) w.applyWindowVisibility();
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        realWindowVisibility = visibility;
        super.onWindowVisibilityChanged(WindowHold.effective(visibility, held));
    }

    private void applyWindowVisibility() {
        if (isAttachedToWindow()) super.onWindowVisibilityChanged(WindowHold.effective(realWindowVisibility, held));
    }
}
