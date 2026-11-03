package com.moviemethat.arclight.car;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.moviemethat.arclight.car.ControllerPolicy.Access;
import org.junit.Test;

public class ControllerPolicyTest {

    private static final String OWN = "com.moviemethat.arclight";
    private static final int APP_UID = 10_123;

    @Test
    public void ownPackageGetsEverything() {
        assertEquals(Access.FULL, ControllerPolicy.decide(OWN, APP_UID, OWN, false, false));
    }

    @Test
    public void trustedControllersGetEverything() {
        // System UI (MEDIA_CONTENT_CONTROL), the system process and Bluetooth.
        assertEquals(Access.FULL, ControllerPolicy.decide("com.android.systemui", 10_050, OWN, true, false));
        assertEquals(Access.FULL, ControllerPolicy.decide("android", ControllerPolicy.SYSTEM_UID, OWN, false, false));
        assertEquals(Access.FULL, ControllerPolicy.decide("com.android.bluetooth", ControllerPolicy.BLUETOOTH_UID, OWN, false, false));
    }

    @Test
    public void genuineCarHostsGetEverything() {
        assertEquals(Access.FULL, ControllerPolicy.decide(ControllerPolicy.ANDROID_AUTO, 10_200, OWN, false, true));
        assertEquals(Access.FULL, ControllerPolicy.decide(ControllerPolicy.AUTOMOTIVE_MEDIA, 10_201, OWN, false, true));
        assertEquals(Access.FULL, ControllerPolicy.decide(ControllerPolicy.AUTOMOTIVE_ASSISTANT, 10_202, OWN, false, true));
    }

    @Test
    public void aCarHostNameAloneIsNotEnough() {
        assertEquals(Access.REJECT, ControllerPolicy.decide(ControllerPolicy.ANDROID_AUTO, 10_300, OWN, false, false));
    }

    @Test
    public void unknownPlatformControllersOnlyControlPlayback() {
        assertEquals(Access.PLAYBACK, ControllerPolicy.decide(ControllerPolicy.LEGACY_UNKNOWN, 10_400, OWN, false, false));
    }

    @Test
    public void randomAppsAreRejected() {
        assertEquals(Access.REJECT, ControllerPolicy.decide("com.example.snoop", 10_500, OWN, false, false));
        // "Genuine" is only looked at for car hosts.
        assertEquals(Access.REJECT, ControllerPolicy.decide("com.example.snoop", 10_500, OWN, false, true));
        assertEquals(Access.REJECT, ControllerPolicy.decide(null, 10_500, OWN, false, false));
        assertEquals(Access.REJECT, ControllerPolicy.decide("", 10_500, OWN, false, false));
    }

    @Test
    public void carHostList() {
        assertTrue(ControllerPolicy.isCarHost(ControllerPolicy.ANDROID_AUTO));
        assertFalse(ControllerPolicy.isCarHost(OWN));
        assertFalse(ControllerPolicy.isCarHost(null));
    }
}
