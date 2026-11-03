package com.moviemethat.arclight.video;

/**
 * Which sprite-sheet tile shows a position (same rule as trickplayTileAt in packages/shared):
 * tile n covers [n*interval, (n+1)*interval); sheet = n / (columns*rows); inside the sheet
 * col = n % columns, row = (n % (columns*rows)) / columns. Pure, JVM unit-testable.
 */
public final class TrickplayMath {

    private TrickplayMath() {}

    public static final class Tile {
        public final int sheet;
        /** Pixel offset of the tile inside its sheet. */
        public final int x;
        public final int y;

        Tile(int sheet, int x, int y) {
            this.sheet = sheet;
            this.x = x;
            this.y = y;
        }
    }

    public static Tile tileAt(VideoRequest.Trickplay t, long ms) {
        return tileAt(t.intervalMs, t.tileWidth, t.tileHeight, t.columns, t.rows, t.tileCount, ms);
    }

    public static Tile tileAt(long intervalMs, int tileWidth, int tileHeight, int columns, int rows, int tileCount, long ms) {
        long raw = intervalMs <= 0 ? 0 : Math.floorDiv(ms, intervalMs);
        int n = (int) Math.max(0, Math.min(tileCount - 1, raw));
        int per = Math.max(1, columns * rows);
        int i = n % per;
        return new Tile(n / per, (i % columns) * tileWidth, (i / columns) * tileHeight);
    }
}
