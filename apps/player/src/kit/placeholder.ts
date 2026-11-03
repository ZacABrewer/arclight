// Placeholder art while an image loads, or when there is none: the design's `bg(h)` gradient
// with h a hash of the title (spec §4.1). Stand-in for C's `redesign/placeholder`.

/** 0..359 from any string (FNV-1a). */
export function hueOf(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

export function placeholderArt(seed: string, shift = 0): string {
  const h = hueOf(seed) + shift;
  return `radial-gradient(120% 90% at 75% 20%, oklch(0.55 0.11 ${h}) 0%, oklch(0.32 0.07 ${h + 30}) 55%, oklch(0.18 0.03 ${h + 60}) 100%)`;
}

/** The image over its placeholder, as one CSS background. */
export function artBackground(url: string | null | undefined, seed: string, shift = 0): string {
  const ph = placeholderArt(seed, shift);
  return url ? `center / cover no-repeat url("${url.replace(/"/g, '%22')}"), ${ph}` : ph;
}
