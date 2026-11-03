package com.moviemethat.arclight.video;

/**
 * How much the video player buffers (playback design §4.7), as plain numbers for
 * DefaultLoadControl so the rule is JVM unit-testable.
 *
 * <ul>
 *   <li>At least 30 s ahead, up to 120 s on phones and 60 s on TVs and low-RAM devices (HLS
 *       segments are cheap to keep, and a deep buffer rides out Wi-Fi dips and VBR peaks).</li>
 *   <li>Playback starts with 2.5 s and resumes after a rebuffer with 5 s (Media3's defaults).</li>
 *   <li>30 s kept behind the playhead (from a keyframe), so a ±10 s seek back is local.</li>
 *   <li>A byte ceiling of a quarter of the app's heap, between 32 MB and 150 MB: Media3 buffers in
 *       Java memory. Size wins over time, so a high-bitrate direct play or copy rung stops at the
 *       ceiling instead of running the heap out.</li>
 * </ul>
 */
public final class LoadControlConfig {

    static final int MB = 1024 * 1024;
    static final int MIN_TARGET_BYTES = 32 * MB;
    static final int MAX_TARGET_BYTES = 150 * MB;

    public final int minBufferMs;
    public final int maxBufferMs;
    public final int bufferForPlaybackMs;
    public final int bufferForPlaybackAfterRebufferMs;
    public final int backBufferMs;
    public final boolean retainBackBufferFromKeyframe;
    public final int targetBufferBytes;
    public final boolean prioritizeTimeOverSizeThresholds;

    LoadControlConfig(int minBufferMs, int maxBufferMs, int bufferForPlaybackMs, int bufferForPlaybackAfterRebufferMs,
            int backBufferMs, boolean retainBackBufferFromKeyframe, int targetBufferBytes, boolean prioritizeTimeOverSizeThresholds) {
        this.minBufferMs = minBufferMs;
        this.maxBufferMs = maxBufferMs;
        this.bufferForPlaybackMs = bufferForPlaybackMs;
        this.bufferForPlaybackAfterRebufferMs = bufferForPlaybackAfterRebufferMs;
        this.backBufferMs = backBufferMs;
        this.retainBackBufferFromKeyframe = retainBackBufferFromKeyframe;
        this.targetBufferBytes = targetBufferBytes;
        this.prioritizeTimeOverSizeThresholds = prioritizeTimeOverSizeThresholds;
    }

    /**
     * @param tv a TV (leanback / television UI mode)
     * @param lowRam {@code ActivityManager.isLowRamDevice()}
     * @param heapMb {@code ActivityManager.getMemoryClass()} (the app's Java heap in MB)
     */
    public static LoadControlConfig forDevice(boolean tv, boolean lowRam, int heapMb) {
        int max = tv || lowRam ? 60_000 : 120_000;
        long quarter = (long) Math.max(0, heapMb) * MB / 4;
        int bytes = (int) Math.max(MIN_TARGET_BYTES, Math.min(MAX_TARGET_BYTES, quarter));
        return new LoadControlConfig(30_000, max, 2_500, 5_000, 30_000, true, bytes, false);
    }
}
