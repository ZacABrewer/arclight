package com.moviemethat.arclight.video;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.view.Display;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.audio.AudioCapabilities;
import com.moviemethat.arclight.SafeLog;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * {@code getDeviceInfo()}: whether this is a TV and what it can play (VideoDeviceProfile in
 * src/native/definitions.ts), from the platform decoders (MediaCodecList), the display's HDR
 * capabilities and the audio output's passthrough capabilities (HDMI / receiver). The pure
 * mapping parts are static and unit-tested.
 */
@UnstableApi
public final class VideoProfile {

    private static final String TAG = "ArclightVideoProfile";

    private VideoProfile() {}

    /** What the decoder scan found. */
    static final class Decoders {
        final Set<String> mimes = new LinkedHashSet<>();
        boolean hevcMain10;
        /** Largest standard height (2160 / 1440 / 1080 / 720 / 480) any video decoder handles. */
        int maxHeight = 480;
    }

    public static JSONObject deviceInfo(Context ctx) throws JSONException {
        boolean tv = isTv(ctx);
        JSONObject o = new JSONObject();
        o.put("isTv", tv);
        o.put("videoProfile", profile(ctx, tv));
        return o;
    }

    public static boolean isTv(Context ctx) {
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        PackageManager pm = ctx.getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || pm.hasSystemFeature(PackageManager.FEATURE_TELEVISION);
    }

    static JSONObject profile(Context ctx, boolean tv) throws JSONException {
        Decoders d = scanDecoders();
        int[] hdrTypes = displayHdrTypes(ctx);
        AudioCapabilities audio = audioCapabilities(ctx);

        JSONObject p = new JSONObject();
        // Media3's extractors read all of these (MOV through the MP4 extractor, WebM through MKV).
        p.put("containers", new JSONArray().put("mp4").put("mkv").put("webm").put("mov"));
        p.put("videoCodecs", toArray(videoCodecs(d.mimes)));
        p.put("hevc10bit", d.hevcMain10);
        p.put("hdr", toArray(hdr(hdrTypes, d.hevcMain10 || d.mimes.contains("video/av01") || d.mimes.contains("video/x-vnd.on2.vp9"),
                d.mimes.contains("video/dolby-vision"))));
        boolean ac3 = audio != null && audio.supportsEncoding(C.ENCODING_AC3);
        boolean eac3 = audio != null && (audio.supportsEncoding(C.ENCODING_E_AC3) || audio.supportsEncoding(C.ENCODING_E_AC3_JOC));
        boolean dts = audio != null && (audio.supportsEncoding(C.ENCODING_DTS) || audio.supportsEncoding(C.ENCODING_DTS_HD));
        boolean truehd = audio != null && audio.supportsEncoding(C.ENCODING_DOLBY_TRUEHD);
        p.put("audioCodecs", toArray(audioCodecs(d.mimes, ac3, eac3, dts, truehd)));
        int outChannels = audio == null ? 2 : audio.getMaxChannelCount();
        p.put("maxAudioChannels", maxAudioChannels(tv, outChannels, ac3 || eac3 || dts || truehd));
        p.put("maxHeight", d.maxHeight);
        return p;
    }

    // ---- probing ----------------------------------------------------------------------------

    static Decoders scanDecoders() {
        Decoders d = new Decoders();
        try {
            for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    String mime = type.toLowerCase(Locale.ROOT);
                    d.mimes.add(mime);
                    if (!mime.startsWith("video/")) continue;
                    MediaCodecInfo.CodecCapabilities caps;
                    try {
                        caps = info.getCapabilitiesForType(type);
                    } catch (IllegalArgumentException e) {
                        continue;
                    }
                    if (mime.equals("video/hevc")) {
                        for (MediaCodecInfo.CodecProfileLevel pl : caps.profileLevels) {
                            if (isHevcMain10(pl.profile)) d.hevcMain10 = true;
                        }
                    }
                    if (isMainVideoMime(mime)) d.maxHeight = Math.max(d.maxHeight, maxStandardHeight(caps.getVideoCapabilities()));
                }
            }
        } catch (RuntimeException e) {
            SafeLog.w(TAG, "Decoder scan failed", e);
            d.mimes.add("video/avc");
            d.mimes.add("audio/mp4a-latm");
            d.maxHeight = 1080;
        }
        return d;
    }

    private static int maxStandardHeight(@Nullable MediaCodecInfo.VideoCapabilities vc) {
        if (vc == null) return 480;
        int[][] sizes = {{3840, 2160}, {2560, 1440}, {1920, 1080}, {1280, 720}};
        for (int[] s : sizes) {
            try {
                if (vc.isSizeSupported(s[0], s[1])) return s[1];
            } catch (RuntimeException ignored) {
                // Some vendor codecs throw for sizes outside their range.
            }
        }
        return 480;
    }

    private static int[] displayHdrTypes(Context ctx) {
        try {
            DisplayManager dm = (DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE);
            Display display = dm == null ? null : dm.getDisplay(Display.DEFAULT_DISPLAY);
            if (display == null) return new int[0];
            if (Build.VERSION.SDK_INT >= 34) return display.getMode().getSupportedHdrTypes();
            Display.HdrCapabilities caps = display.getHdrCapabilities();
            return caps == null ? new int[0] : caps.getSupportedHdrTypes();
        } catch (RuntimeException e) {
            return new int[0];
        }
    }

    @Nullable
    private static AudioCapabilities audioCapabilities(Context ctx) {
        try {
            return AudioCapabilities.getCapabilities(ctx, AudioAttributes.DEFAULT, null);
        } catch (RuntimeException e) {
            SafeLog.w(TAG, "Audio capabilities unavailable", e);
            return null;
        }
    }

    // ---- pure mapping (unit-tested) -------------------------------------------------------------

    static boolean isHevcMain10(int profile) {
        return profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10
                || profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10
                || profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus;
    }

    static boolean isMainVideoMime(String mime) {
        return mime.equals("video/avc") || mime.equals("video/hevc") || mime.equals("video/av01") || mime.equals("video/x-vnd.on2.vp9");
    }

    /** Contract codec names for the decoder MIME types present. */
    static List<String> videoCodecs(Set<String> mimes) {
        List<String> out = new ArrayList<>();
        if (mimes.contains("video/avc")) out.add("h264");
        if (mimes.contains("video/hevc")) out.add("hevc");
        if (mimes.contains("video/av01")) out.add("av1");
        if (mimes.contains("video/x-vnd.on2.vp9")) out.add("vp9");
        if (out.isEmpty()) out.add("h264");
        return out;
    }

    /**
     * Audio codecs: decoders the platform has (plus Media3's built-in FLAC / Opus handling via the
     * platform decoders), and the surround formats the output takes as passthrough.
     */
    static List<String> audioCodecs(Set<String> mimes, boolean ac3Pass, boolean eac3Pass, boolean dtsPass, boolean truehdPass) {
        List<String> out = new ArrayList<>();
        out.add("aac");
        if (mimes.contains("audio/mpeg")) out.add("mp3");
        if (mimes.contains("audio/opus")) out.add("opus");
        if (mimes.contains("audio/flac")) out.add("flac");
        if (mimes.contains("audio/vorbis")) out.add("vorbis");
        if (ac3Pass || mimes.contains("audio/ac3")) out.add("ac3");
        if (eac3Pass || mimes.contains("audio/eac3") || mimes.contains("audio/eac3-joc")) out.add("eac3");
        if (dtsPass || mimes.contains("audio/vnd.dts") || mimes.contains("audio/vnd.dts.hd")) out.add("dts");
        if (truehdPass || mimes.contains("audio/true-hd")) out.add("truehd");
        return out;
    }

    /**
     * HDR formats worth sending: the display shows them and a 10-bit decoder exists (Dolby Vision
     * also needs its own decoder). Display.HdrCapabilities: 1 = Dolby Vision, 2 = HDR10, 3 = HLG.
     */
    static List<String> hdr(int[] displayTypes, boolean tenBitDecoder, boolean dvDecoder) {
        List<String> out = new ArrayList<>();
        if (!tenBitDecoder) return out;
        boolean h10 = false;
        boolean hlg = false;
        boolean dv = false;
        for (int t : displayTypes) {
            if (t == 2) h10 = true;
            else if (t == 3) hlg = true;
            else if (t == 1) dv = true;
        }
        if (h10) out.add("hdr10");
        if (hlg) out.add("hlg");
        if (dv && dvDecoder) out.add("dv");
        return out;
    }

    /**
     * Channels the server may send. Phones play through stereo speakers / headphones, so 2 (the
     * server's downmix beats the phone's). TVs take what the HDMI / receiver output reports, and at
     * least 6 when it accepts a surround bitstream.
     */
    static int maxAudioChannels(boolean tv, int outputChannels, boolean surroundPassthrough) {
        if (!tv) return 2;
        int ch = Math.max(2, Math.min(8, outputChannels));
        if (surroundPassthrough) ch = Math.max(ch, 6);
        return ch;
    }

    private static JSONArray toArray(List<String> list) {
        JSONArray a = new JSONArray();
        for (String s : list) a.put(s);
        return a;
    }
}
