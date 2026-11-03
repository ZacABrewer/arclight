package com.moviemethat.arclight.car;

import androidx.annotation.Nullable;

/**
 * Who may connect to the playback service (PlaybackService is exported so system media
 * controllers and Android Auto can bind to it). Pure Java so it is unit-tested; the callback
 * gathers the facts about the controller and applies the answer.
 *
 * <ul>
 *   <li>FULL (playback, library browsing and search): this app, controllers Android trusts
 *       (system UI, holders of MEDIA_CONTENT_CONTROL, the system and Bluetooth processes), and the
 *       Android Auto / Android Automotive hosts and Google Assistant when the package is a real copy of them (a system
 *       app, or installed by Google Play).</li>
 *   <li>PLAYBACK (play/pause/skip and what is playing, no library): platform controllers whose
 *       package Android cannot name (Android 8 reports them all as one placeholder package), so the
 *       lock screen and headset buttons keep working there.</li>
 *   <li>REJECT: everything else, including an app that only uses a car host's package name.</li>
 * </ul>
 */
public final class ControllerPolicy {

    public enum Access { FULL, PLAYBACK, REJECT }

    /** Android Auto on a phone (projection). */
    public static final String ANDROID_AUTO = "com.google.android.projection.gearhead";
    /** Android Automotive's media centre. */
    public static final String AUTOMOTIVE_MEDIA = "com.android.car.media";
    /** Google Assistant on Android Automotive ("play ... on Arclight"). */
    public static final String AUTOMOTIVE_ASSISTANT = "com.google.android.carassistant";
    /** Google Assistant / Google app on a phone (voice control through Android Auto). */
    public static final String GOOGLE_ASSISTANT = "com.google.android.googlequicksearchbox";

    /** Media3's package name for a platform controller whose package is unknown. */
    public static final String LEGACY_UNKNOWN = "android.media.session.MediaController";

    /** android.os.Process.SYSTEM_UID and BLUETOOTH_UID (media buttons, AVRCP browsing). */
    static final int SYSTEM_UID = 1000;
    static final int BLUETOOTH_UID = 1002;

    private ControllerPolicy() {}

    public static boolean isCarHost(@Nullable String pkg) {
        return ANDROID_AUTO.equals(pkg) || AUTOMOTIVE_MEDIA.equals(pkg) || AUTOMOTIVE_ASSISTANT.equals(pkg)
            || GOOGLE_ASSISTANT.equals(pkg);
    }

    /**
     * @param pkg the controller's package
     * @param uid the controller's uid
     * @param ownPkg this app's package
     * @param trusted {@code ControllerInfo.isTrusted()}
     * @param carHostGenuine the package is a system app or was installed by Google Play (only
     *     looked at for car host packages)
     */
    public static Access decide(@Nullable String pkg, int uid, String ownPkg, boolean trusted, boolean carHostGenuine) {
        if (pkg == null || pkg.isEmpty()) return Access.REJECT;
        if (pkg.equals(ownPkg)) return Access.FULL;
        if (trusted || uid == SYSTEM_UID || uid == BLUETOOTH_UID) return Access.FULL;
        if (isCarHost(pkg)) return carHostGenuine ? Access.FULL : Access.REJECT;
        if (LEGACY_UNKNOWN.equals(pkg)) return Access.PLAYBACK;
        return Access.REJECT;
    }
}
