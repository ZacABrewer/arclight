// Self-hosted fonts for Arclight (a NAS app should not call out to Google Fonts).
// Archivo: variable weight 100–900 *and* width 62–125% (the kit sets headings at 112–125%
// stretch), from @fontsource-variable/archivo's `wdth` build. JetBrains Mono: the two
// weights the kit uses (400 data, 500 labels/codes).
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

/** Family names as registered by the font packages (see styles/arclight/fonts.css). */
export const FONT_FAMILIES = {
  ui: 'Archivo Variable',
  mono: 'JetBrains Mono',
} as const;
