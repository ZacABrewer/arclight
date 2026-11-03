package com.moviemethat.arclight.admin;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Lets the WebView show the user's own Arclight servers with the Capacitor bridge available.
 *
 * Capacitor only exposes its bridge to the app's own origin (https://localhost) and to hosts
 * listed in server.allowNavigation at build time. Arclight servers are at addresses the user
 * types at runtime, so this plugin:
 *
 *  1. keeps the saved servers' origins (handed over by the TS layer via setServerOrigins);
 *  2. lets those origins load inside the WebView (shouldOverrideLoad); every other site still
 *     opens in the system browser through Capacitor's default handling;
 *  3. injects Capacitor's bridge script plus dist/arclight-shell.js (which defines
 *     window.Capacitor.Plugins.ArclightShell) at document start, for those origins only;
 *  4. re-registers the "androidBridge" message listener so messages are accepted from the app
 *     origin and those origins only, main frame only (iframes on a server page get nothing).
 *
 * Steps 3 and 4 use reflection on two private members of com.getcapacitor.Bridge
 * (getJSInjector, msgHandler). Capacitor is pinned to an exact version in package.json; check
 * these names when upgrading it. If reflection fails the app still works as a browser for the
 * server, only without the native shell features (push, switch server button).
 */
@CapacitorPlugin(name = "ArclightNative")
public class ArclightNativePlugin extends Plugin {

    private static final String TAG = "ArclightNative";
    private static final String PREFS = "ArclightNative";
    private static final String KEY_ORIGINS = "serverOrigins";

    private final Set<String> origins = Collections.synchronizedSet(new HashSet<>());
    private final List<ScriptHandler> scriptHandlers = new ArrayList<>();
    private String injectedScript;

    @Override
    public void load() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        origins.addAll(prefs.getStringSet(KEY_ORIGINS, Collections.emptySet()));

        installMessageListener(bridge.getWebView());

        // Other plugins are still being registered while load() runs; build the injected script
        // (which lists every plugin) once the bridge is complete.
        new Handler(Looper.getMainLooper()).post(this::updateDocumentStartScripts);

        // Capacitor's SystemBars sets --safe-area-inset-* only when insets change; re-apply them
        // after each page load so a newly loaded server page gets them too.
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    ViewCompat.requestApplyInsets(webView);
                }
            }
        );
    }

    @PluginMethod
    public void setServerOrigins(PluginCall call) {
        JSArray list = call.getArray("origins", new JSArray());
        Set<String> next = new HashSet<>();
        try {
            for (Object o : list.toList()) {
                if (o instanceof String) {
                    String origin = normalizeOrigin(Uri.parse((String) o));
                    if (origin != null) next.add(origin);
                }
            }
        } catch (Exception e) {
            call.reject("origins must be a list of URLs");
            return;
        }
        synchronized (origins) {
            origins.clear();
            origins.addAll(next);
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY_ORIGINS, next).apply();
        bridge.executeOnMainThread(() -> {
            updateDocumentStartScripts();
            call.resolve();
        });
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        // The google-services Gradle plugin generates this resource from google-services.json;
        // without it Firebase is not configured and registering for push would fail.
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        ret.put("pushAvailable", id != 0);
        ret.put("localUrl", bridge.getLocalUrl());
        ret.put("pushEnvironment", "production");
        call.resolve(ret);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String origin = normalizeOrigin(url);
        if (origin != null && origins.contains(origin)) {
            return false; // a saved server: load it in the WebView
        }
        return null; // Capacitor decides: the app's own pages load, other sites open externally
    }

    private boolean isAllowedSource(String origin) {
        String normalized = normalizeOrigin(Uri.parse(origin));
        if (normalized == null) return false;
        String local = normalizeOrigin(Uri.parse(bridge.getLocalUrl()));
        return normalized.equals(local) || origins.contains(normalized);
    }

    /** scheme://host[:port] with default ports dropped, lower case; null for non-http(s). */
    static String normalizeOrigin(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return null;
        scheme = scheme.toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        host = host.toLowerCase();
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
        return scheme + "://" + host + (defaultPort ? "" : ":" + port);
    }

    private void installMessageListener(WebView webView) {
        if (bridge.getConfig().isUsingLegacyBridge() || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Legacy addJavascriptInterface bridge: already reachable from every page.
            return;
        }
        try {
            Field field = Bridge.class.getDeclaredField("msgHandler");
            field.setAccessible(true);
            final MessageHandler handler = (MessageHandler) field.get(bridge);
            if (handler == null) return;
            WebViewCompat.removeWebMessageListener(webView, "androidBridge");
            // Replies then travel via evaluateJavascript(window.Capacitor.fromNative(...)), which
            // targets the current main frame.
            WebViewCompat.addWebMessageListener(
                webView,
                "androidBridge",
                Collections.singleton("*"),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || message.getData() == null) return;
                    if (!isAllowedSource(sourceOrigin.toString())) {
                        Logger.warn(TAG, "Ignored bridge message from " + sourceOrigin);
                        return;
                    }
                    handler.postMessage(message.getData());
                }
            );
        } catch (Exception e) {
            Logger.error(TAG, "Could not extend the Capacitor bridge to server pages", e);
        }
    }

    private void updateDocumentStartScripts() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        for (ScriptHandler h : scriptHandlers) h.remove();
        scriptHandlers.clear();
        Set<String> snapshot;
        synchronized (origins) {
            snapshot = new HashSet<>(origins);
        }
        if (snapshot.isEmpty()) return;
        if (injectedScript == null) injectedScript = buildInjectedScript();
        if (injectedScript == null) return;
        WebView webView = bridge.getWebView();
        // One handler per origin, so one unusual origin cannot keep the others from working.
        for (String origin : snapshot) {
            try {
                scriptHandlers.add(WebViewCompat.addDocumentStartJavaScript(webView, injectedScript, Collections.singleton(origin)));
            } catch (IllegalArgumentException e) {
                Logger.warn(TAG, "Cannot inject the shell into " + origin + ": " + e.getMessage());
            }
        }
    }

    private String buildInjectedScript() {
        try {
            Method getInjector = Bridge.class.getDeclaredMethod("getJSInjector");
            getInjector.setAccessible(true);
            Object injector = getInjector.invoke(bridge);
            if (injector == null) return null;
            Method getScript = injector.getClass().getDeclaredMethod("getScriptString");
            getScript.setAccessible(true);
            String capacitorJs = (String) getScript.invoke(injector);
            String shellJs = readAsset("public/arclight-shell.js");
            return capacitorJs + "\nwindow.__ARCLIGHT_NATIVE__ = { localUrl: " + JSONObject.quote(bridge.getLocalUrl()) + " };\n" + shellJs;
        } catch (Exception e) {
            Logger.error(TAG, "Could not build the server page script", e);
            return null;
        }
    }

    private String readAsset(String path) throws Exception {
        try (InputStream in = getContext().getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
