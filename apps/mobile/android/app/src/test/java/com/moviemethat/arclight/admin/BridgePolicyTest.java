package com.moviemethat.arclight.admin;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BridgePolicyTest {

    private static final String RELAY = "https://arclight-push.moviemethat.com";

    private static boolean call(String plugin, String method) {
        return BridgePolicy.allowServerPage("message", plugin, method, null, null, null, RELAY);
    }

    @Test
    public void allowsWhatTheShellNeeds() {
        assertTrue(call("ArclightNative", "getInfo"));
        assertTrue(call("ArclightNative", "shellState"));
        assertTrue(call("ArclightNative", "secureGet"));
        assertTrue(call("ArclightNative", "secureSet"));
        assertTrue(call("PushNotifications", "register"));
        assertTrue(call("PushNotifications", "checkPermissions"));
        assertTrue(call("Device", "getInfo"));
        assertTrue(call("App", "getLaunchUrl"));
        assertTrue(call("NativeBiometric", "verifyIdentity"));
        assertTrue(BridgePolicy.allowServerPage("js.error", null, null, null, null, null, null));
    }

    @Test
    public void refusesTheAppsOwnState() {
        assertFalse(call("Preferences", "get"));
        assertFalse(call("Preferences", "set"));
        assertFalse(call("ArclightNative", "setServerOrigins"));
        assertFalse(call("CapacitorCookies", "getCookies"));
        assertFalse(call("CapacitorBarcodeScanner", "scanBarcode"));
        assertFalse(call("PushNotifications", "unregister"));
        assertFalse(call("PushNotifications", "getDeliveredNotifications"));
        assertFalse(call("PushNotifications", "createChannel"));
        assertFalse(call("Haptics", "impact"));
        assertFalse(call("WebView", "setServerBasePath"));
        assertFalse(call(null, null));
        assertFalse(BridgePolicy.allowServerPage("cordova", "Device", "getInfo", null, null, null, RELAY));
    }

    @Test
    public void listenersByEvent() {
        assertTrue(BridgePolicy.allowServerPage("message", "PushNotifications", "addListener", "pushNotificationActionPerformed", null, null, RELAY));
        assertTrue(BridgePolicy.allowServerPage("message", "PushNotifications", "addListener", "registration", null, null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "PushNotifications", "addListener", "pushNotificationReceived", null, null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "PushNotifications", "addListener", null, null, null, RELAY));
        assertTrue(BridgePolicy.allowServerPage("message", "App", "addListener", "appUrlOpen", null, null, RELAY));
        assertTrue(BridgePolicy.allowServerPage("message", "CapacitorShareTarget", "addListener", "shareReceived", null, null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "Device", "addListener", "x", null, null, RELAY));
    }

    @Test
    public void browserOpensWebLinksOnly() {
        assertTrue(BridgePolicy.allowServerPage("message", "Browser", "open", null, "https://www.themoviedb.org/movie/1", null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "Browser", "open", null, "intent://scan#Intent;end", null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "Browser", "open", null, "file:///data/data/x", null, RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "Browser", "open", null, null, null, RELAY));
    }

    @Test
    public void httpOnlyToTheRelayDeviceEndpoints() {
        assertTrue(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices", "POST", RELAY));
        assertTrue(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices/abc-123", "put", RELAY));
        assertTrue(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + ":443/v1/devices/abc", "DELETE", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices", "GET", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/send", "POST", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices/a/../../x", "POST", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices?x=1", "POST", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, "http://192.168.1.20:7878/api/v1/system", "GET", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, "https://evil.example.com/v1/devices", "POST", RELAY));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "request", null, RELAY + "/v1/devices", "POST", null));
        assertFalse(BridgePolicy.allowServerPage("message", "CapacitorHttp", "get", null, RELAY + "/v1/devices", "GET", RELAY));
    }

    @Test
    public void origins() {
        assertEquals("https://a.example.com", BridgePolicy.origin("HTTPS://A.example.com:443/x"));
        assertEquals("http://nas:7878", BridgePolicy.origin("http://nas:7878/"));
        assertEquals("http://[fd12::1]:8080", BridgePolicy.origin("http://[fd12::1]:8080"));
        assertNull(BridgePolicy.origin("https://user@a.example.com/"));
        assertNull(BridgePolicy.origin("javascript:alert(1)"));
        assertNull(BridgePolicy.origin(null));
    }
}
