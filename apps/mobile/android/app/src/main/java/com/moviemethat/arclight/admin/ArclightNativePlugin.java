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
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Lets the WebView show the user's own Arclight servers with a limited Capacitor bridge.
 *
 * Capacitor only exposes its bridge to the app's own origin (https://localhost) and to hosts
 * listed in server.allowNavigation at build time. Arclight servers are at addresses the user
 * types at runtime, so this plugin:
 *
 *  1. keeps the saved servers' origins (handed over by the app's own screens via
 *     setServerOrigins; only origins that passed the cleartext policy are listed);
 *  2. lets those origins load inside the WebView (shouldOverrideLoad); every other site still
 *     opens in the system browser through Capacitor's default handling;
 *  3. injects Capacitor's bridge script plus dist/arclight-shell.js (which defines
 *     window.Capacitor.Plugins.ArclightShell) at document start, for those origins only;
 *  4. re-registers the "androidBridge" message listener with a gate (CLI-01): the app's own
 *     origin gets the full bridge; a saved server's page gets only the calls in BridgePolicy
 *     (main frame only; iframes on a server page get nothing), and its ArclightNative calls are
 *     scoped to its own origin.
 *
 * Steps 3 and 4 use reflection on two private members of com.getcapacitor.Bridge
 * (getJSInjector, msgHandler). Capacitor is pinned to an exact version in package.json; check
 * these names when upgrading it. If reflection fails, Capacitor's own listener stays in place and
 * only accepts the app's own origin: server pages still load, without the native shell features.
 * With the legacy addJavascriptInterface bridge every page could reach every plugin, so then
 * servers are not loaded in the WebView at all (they open in the system browser).
 */
@CapacitorPlugin(name = "ArclightNative")
public class ArclightNativePlugin extends Plugin {

    private static final String TAG = "ArclightNative";
    private static final String PREFS = "ArclightNative";
    private static final String KEY_ORIGINS = "serverOrigins";
    private static final String KEY_SHELL = "shellState";
    private static final String KEY_RELAY = "relayOrigin";

    private final Set<String> origins = Collections.synchronizedSet(new HashSet<>());
    private final List<ScriptHandler> scriptHandlers = new ArrayList<>();
    private String injectedScript;
    private volatile JSONObject shells = new JSONObject();
    private volatile String relayOrigin;
    private volatile boolean legacyBridge;
    private SecureStore secure;

    @Override
    public void load() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        origins.addAll(prefs.getStringSet(KEY_ORIGINS, Collections.emptySet()));
        try {
            shells = new JSONObject(prefs.getString(KEY_SHELL, "{}"));
        } catch (Exception e) {
            shells = new JSONObject();
        }
        relayOrigin = prefs.getString(KEY_RELAY, null);
        secure = new SecureStore(getContext());

        legacyBridge = bridge.getConfig().isUsingLegacyBridge() || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
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

    /** The calling server page's origin (set by the gate), or null for the app's own screens. */
    private static String caller(PluginCall call) {
        return call.getString(BridgePolicy.CALLER, null);
    }

    @PluginMethod
    public void setServerOrigins(PluginCall call) {
        if (caller(call) != null) {
            call.reject("Not available to server pages");
            return;
        }
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
        // What each origin's pages may read (shellState); nothing for origins that are not listed.
        JSONObject given = call.getObject("shell", new JSObject());
        JSONObject nextShells = new JSONObject();
        try {
            for (Iterator<String> it = given.keys(); it.hasNext(); ) {
                String k = it.next();
                String origin = normalizeOrigin(Uri.parse(k));
                JSONObject snap = given.optJSONObject(k);
                if (origin != null && next.contains(origin) && snap != null) nextShells.put(origin, snap);
            }
        } catch (Exception e) {
            call.reject("shell must map origins to snapshots");
            return;
        }
        String relay = BridgePolicy.origin(call.getString("relayUrl", null));
        if (relay != null && !relay.startsWith("https://")) relay = null;

        synchronized (origins) {
            origins.clear();
            origins.addAll(next);
        }
        shells = nextShells;
        if (relay != null) relayOrigin = relay;
        SharedPreferences.Editor ed = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putStringSet(KEY_ORIGINS, next).putString(KEY_SHELL, nextShells.toString());
        if (relay != null) ed.putString(KEY_RELAY, relay);
        ed.apply();
        bridge.executeOnMainThread(() -> {
            updateDocumentStartScripts();
            call.resolve();
        });
    }

    @PluginMethod
    public void shellState(PluginCall call) {
        String origin = caller(call);
        JSObject ret = new JSObject();
        JSONObject snap = origin == null ? null : shells.optJSONObject(origin);
        ret.put("state", snap == null ? JSONObject.NULL : snap);
        call.resolve(ret);
    }

    /** A server page always gets its own origin's scope, whatever it asks for. */
    private static String scope(PluginCall call) {
        String origin = caller(call);
        return origin != null ? origin : call.getString("scope", "");
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        JSObject ret = new JSObject();
        String v = secure.get(scope(call), key);
        ret.put("value", v == null ? JSONObject.NULL : v);
        call.resolve(ret);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            secure.set(scope(call), key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not store the value securely");
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        secure.remove(scope(call), key);
        call.resolve();
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
        if (legacyBridge) return null; // see the class comment
        String origin = normalizeOrigin(url);
        if (origin != null && origins.contains(origin)) {
            return false; // a saved server: load it in the WebView
        }
        return null; // Capacitor decides: the app's own pages load, other sites open externally
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
        if (legacyBridge) return;
        try {
            Field field = Bridge.class.getDeclaredField("msgHandler");
            field.setAccessible(true);
            final MessageHandler handler = (MessageHandler) field.get(bridge);
            if (handler == null) return;
            final String local = normalizeOrigin(Uri.parse(bridge.getLocalUrl()));
            WebViewCompat.removeWebMessageListener(webView, "androidBridge");
            // Replies then travel via evaluateJavascript(window.Capacitor.fromNative(...)), which
            // targets the current main frame.
            WebViewCompat.addWebMessageListener(
                webView,
                "androidBridge",
                Collections.singleton("*"),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    String data = message.getData();
                    if (!isMainFrame || data == null) return;
                    String source = normalizeOrigin(Uri.parse(sourceOrigin.toString()));
                    if (source != null && source.equals(local)) {
                        // The app's own screens: everything, but never a forged caller stamp.
                        if (!data.contains(BridgePolicy.CALLER)) handler.postMessage(data);
                        else gate(handler, data, null);
                    } else if (source != null && origins.contains(source)) {
                        gate(handler, data, source);
                    } else {
                        Logger.warn(TAG, "Ignored bridge message from " + sourceOrigin);
                    }
                }
            );
        } catch (Exception e) {
            Logger.error(TAG, "Could not extend the Capacitor bridge to server pages", e);
        }
    }

    /** server: the calling server page's origin, or null for the app's own screens. */
    private void gate(MessageHandler handler, String data, String server) {
        JSONObject msg;
        try {
            msg = new JSONObject(data);
        } catch (Exception e) {
            return;
        }
        String type = msg.optString("type", null);
        String pluginId = msg.optString("pluginId", null);
        String methodName = msg.optString("methodName", null);
        JSONObject options = msg.optJSONObject("options");
        if (options == null) options = new JSONObject();
        options.remove(BridgePolicy.CALLER);
        if (server != null) {
            boolean ok = BridgePolicy.allowServerPage(
                type,
                pluginId,
                methodName,
                options.optString("eventName", null),
                options.optString("url", null),
                options.optString("method", "GET"),
                relayOrigin
            );
            if (!ok) {
                Logger.warn(TAG, "Refused " + pluginId + "." + methodName + " from a server page");
                String callbackId = msg.optString("callbackId", null);
                if (callbackId != null && pluginId != null && methodName != null && !"cordova".equals(type)) {
                    new PluginCall(handler, pluginId, callbackId, methodName, new JSObject()).reject("Not available to server pages", "UNAVAILABLE");
                }
                return;
            }
            if ("ArclightNative".equals(pluginId)) {
                try {
                    options.put(BridgePolicy.CALLER, server);
                } catch (Exception e) {
                    return;
                }
            }
        }
        try {
            if (msg.has("options") || server != null) msg.put("options", options);
        } catch (Exception e) {
            return;
        }
        handler.postMessage(msg.toString());
    }

    private void updateDocumentStartScripts() {
        if (legacyBridge || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
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
