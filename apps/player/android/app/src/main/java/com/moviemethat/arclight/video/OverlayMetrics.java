package com.moviemethat.arclight.video;

/**
 * Overlay geometry on the 1280x720 design stage (template px). The overlay is laid out at stage
 * size and scaled to the screen by {@link #scale}. Pure.
 */
public final class OverlayMetrics {

    private OverlayMetrics() {}

    public static final int STAGE_W = 1280;
    public static final int STAGE_H = 720;
    /** Left / right margin of the overlay content. */
    public static final int SIDE = 56;
    public static final int PREVIEW_W = 240;
    public static final int PREVIEW_H = 135;

    /** Stage-to-screen scale for a screen of {@code widthDp} x {@code heightDp}. */
    public static float scale(float widthDp, float heightDp) {
        if (widthDp <= 0 || heightDp <= 0) return 1f;
        return Math.min(widthDp / STAGE_W, heightDp / STAGE_H);
    }

    /**
     * Left edge of a {@code boxW}-wide preview centred on {@code knobX}, kept inside the side
     * margins of a {@code stageW}-wide stage.
     */
    public static float previewLeft(float knobX, float boxW, float stageW) {
        float left = knobX - boxW / 2f;
        float max = stageW - SIDE - boxW;
        return Math.max(SIDE, Math.min(max < SIDE ? SIDE : max, left));
    }

    /** Bottom offset of the skip button and the up-next card: above the controls when shown. */
    public static int cornerBottom(boolean controlsShown) {
        return controlsShown ? 168 : 48;
    }

    /** Bottom offset of the captions. */
    public static int captionBottom(boolean controlsShown) {
        return controlsShown ? 232 : 72;
    }
}
