// Placeholder art while artwork loads, or when there is none (redesign spec §4.1): the design
// template's bg(h), a radial gradient whose hue comes from a hash of the title. Lightness and
// chroma read the --al-pl-placeholder-* tokens so a theme can tone it down.

/** A stable hue 0-359 for `seed` (FNV-1a over the UTF-16 code units). */
export function placeholderHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/** Same as placeholderHue (the name builder D's stand-in uses). */
export const hueOf = placeholderHue;

/** CSS `background` for a title's placeholder. `shift` turns the hue (episode stills of one show). */
export function placeholderArt(seed: string, shift = 0): string {
  const h = (placeholderHue(seed) + Math.round(shift)) % 360;
  const c = 'var(--al-pl-placeholder-c, 0.11)';
  return (
    'radial-gradient(120% 90% at 75% 20%, ' +
    `oklch(var(--al-pl-placeholder-l1, 0.55) ${c} ${h}) 0%, ` +
    `oklch(var(--al-pl-placeholder-l2, 0.32) calc(${c} * 0.64) ${(h + 30) % 360}) 55%, ` +
    `oklch(var(--al-pl-placeholder-l3, 0.18) calc(${c} * 0.27) ${(h + 60) % 360}) 100%)`
  );
}

/** The image over its placeholder as one CSS `background` (the placeholder shows until it loads). */
export function artBackground(url: string | null | undefined, seed: string, shift = 0): string {
  const ph = placeholderArt(seed, shift);
  return url ? `center / cover no-repeat url("${url.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}"), ${ph}` : ph;
}
