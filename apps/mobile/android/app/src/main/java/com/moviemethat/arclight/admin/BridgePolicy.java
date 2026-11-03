package com.moviemethat.arclight.admin;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Which Capacitor bridge calls a saved server's page may make (CLI-01).
 *
 * A server page runs the server's own web UI plus dist/arclight-shell.js in one JavaScript
 * context, so anything the shell may call, the page may call too. The list below is what the
 * shell needs and nothing more: no Preferences (the app's server list, settings, cleartext
 * answers), no setServerOrigins, no cookies, no scanner, no Cordova plugins. ArclightNative
 * calls are stamped with the caller's origin (CALLER) so the plugin scopes them to that server.
 *
 * Pure Java (no Android types) so it runs in local unit tests.
 */
final class BridgePolicy {

    /** Option the gate sets on ArclightNative calls from a server page: that page's origin. */
    static final String CALLER = "__arclightCaller";

    private static final Set<String> ANY = Collections.emptySet();
    private static final Map<String, Map<String, Set<String>>> ALLOWED = new HashMap<>();

    static {
        allow("ArclightNative", "getInfo", "shellState", "secureGet", "secureSet", "secureRemove");
        allow("App", "getInfo", "getLaunchUrl", "removeListener", "removeAllListeners");
        listen("App", "appUrlOpen", "appStateChange");
        allow("PushNotifications", "checkPermissions", "requestPermissions", "register", "removeListener", "removeAllListeners");
        // Not pushNotificationReceived: a foreground server page has no use for other servers' payloads.
        listen("PushNotifications", "registration", "registrationError", "pushNotificationActionPerformed");
        allow("Device", "getInfo");
        allow("Browser", "open"); // http(s) URLs only, see allowServerPage
        allow("NativeBiometric", "isAvailable", "verifyIdentity");
        allow("CapacitorShareTarget", "removeListener", "removeAllListeners");
        listen("CapacitorShareTarget", "shareReceived");
        allow("CapacitorHttp", "request"); // the push relay's device endpoints only
    }

    private BridgePolicy() {}

    private static void allow(String plugin, String... methods) {
        Map<String, Set<String>> m = ALLOWED.computeIfAbsent(plugin, k -> new HashMap<>());
        for (String method : methods) m.put(method, ANY);
    }

    private static void listen(String plugin, String... events) {
        ALLOWED.computeIfAbsent(plugin, k -> new HashMap<>()).put("addListener", new HashSet<>(Arrays.asList(events)));
    }

    /**
     * Whether a bridge message from a saved server's page may go through.
     *
     * @param type        message type ("message" for plugin calls, "cordova", "js.error")
     * @param eventName   options.eventName (addListener)
     * @param url         options.url (Browser.open, CapacitorHttp.request)
     * @param httpMethod  options.method (CapacitorHttp.request)
     * @param relayOrigin the push relay's origin as handed over by the app's own screens, or null
     */
    static boolean allowServerPage(String type, String pluginId, String methodName, String eventName, String url, String httpMethod, String relayOrigin) {
        if ("js.error".equals(type)) return true; // console reporting only
        if ("cordova".equals(type) || pluginId == null || methodName == null) return false;
        Map<String, Set<String>> methods = ALLOWED.get(pluginId);
        if (methods == null) return false;
        Set<String> events = methods.get(methodName);
        if (events == null) return false;
        if ("addListener".equals(methodName)) return eventName != null && events.contains(eventName);
        if ("Browser".equals(pluginId)) {
            String o = origin(url);
            return o != null;
        }
        if ("CapacitorHttp".equals(pluginId)) return isRelayDeviceCall(url, httpMethod, relayOrigin);
        return true;
    }

    /** POST/PUT/DELETE {relay}/v1/devices[/id] over https. */
    static boolean isRelayDeviceCall(String url, String httpMethod, String relayOrigin) {
        if (relayOrigin == null || url == null || httpMethod == null) return false;
        String m = httpMethod.toUpperCase(Locale.ROOT);
        if (!m.equals("POST") && !m.equals("PUT") && !m.equals("DELETE")) return false;
        String o = origin(url);
        if (o == null || !o.startsWith("https://") || !o.equals(relayOrigin)) return false;
        try {
            URI u = new URI(url);
            String path = u.getRawPath();
            if (u.getRawQuery() != null || u.getRawFragment() != null || path == null) return false;
            if (path.equals("/v1/devices")) return true;
            if (!path.startsWith("/v1/devices/")) return false;
            String id = path.substring("/v1/devices/".length());
            return !id.isEmpty() && id.matches("[A-Za-z0-9._~%-]+") && !id.contains("%2F") && !id.contains("%2f") && !id.equals("..") && !id.equals(".");
        } catch (Exception e) {
            return false;
        }
    }

    /** scheme://host[:port], lower case, default ports dropped; null unless http(s) with a host. */
    static String origin(String url) {
        if (url == null) return null;
        try {
            URI u = new URI(url);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null || host.isEmpty() || u.getRawUserInfo() != null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
            int port = u.getPort();
            boolean defaultPort = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
            return scheme + "://" + host + (defaultPort ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }
}
