import { createHash } from 'node:crypto';

// Generates a Jellyfin Web stylesheet from an installed Arclight theme pack. The pack's own
// stylesheet targets Arclight's markup; this reads only its design tokens (the `--al-*` custom
// properties of its `[data-theme="<id>"]` block and its @font-face rules) and maps them onto
// Jellyfin Web's classes. Colours, fonts, radii, borders and shadows only: nothing here changes
// layout, sizes, spacing or visibility. Generated at request time, never stored in the repo.

/** Bump when the mapping changes so cached copies (ETag) are refreshed. */
export const THEME_CSS_GENERATOR_VERSION = 2;

export interface ThemePackForCss {
  id: string;
  name: string;
  version: string;
  colorScheme: 'dark' | 'light';
  /** Where the pack came from (part of the ETag: a synced copy of the same version can differ). */
  source: string;
  /** The pack's theme.css. */
  css: string;
  /** Whether the pack ships `fonts/<file>` (only those fonts get an @font-face). */
  hasFont: (file: string) => boolean;
}

/** Strong ETag of the generated stylesheet. */
export function themeCssEtag(pack: Pick<ThemePackForCss, 'id' | 'version' | 'source'>): string {
  const h = createHash('sha256').update(`${pack.id}@${pack.version}#${pack.source}#gen${THEME_CSS_GENERATOR_VERSION}`).digest('hex').slice(0, 32);
  return `"${h}"`;
}

const TOKEN_NAME = /^--al-[a-z0-9-]{1,48}$/;
const FONT_FILE = /^[A-Za-z0-9._-]{1,80}\.woff2$/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Splits declarations on `;` outside parentheses and quotes. */
function splitDeclarations(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Body of every `{ ... }` block whose selector matches, braces balanced. */
function blocks(css: string, selector: (sel: string) => boolean): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    const body = css.slice(open + 1, j - 1);
    // Top-level rules only: tokens inside @media / @supports blocks are ignored.
    if (selector(sel)) out.push(body);
    i = j;
  }
  return out;
}

/** A token value that is safe to copy: no url(), imports, braces, angle brackets or escapes. */
export function safeTokenValue(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 600) return false;
  return !/url\s*\(|@import|expression\s*\(|javascript:|[{}<>\\]|!important/i.test(v);
}

/** The `--al-*` tokens the pack defines for its theme (first definition of each wins over none; later ones override). */
export function parseThemeTokens(css: string, id: string): Map<string, string> {
  const clean = stripComments(css);
  const tokens = new Map<string, string>();
  const ownSelector = (sel: string) =>
    sel
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .some((s) => s === `[data-theme="${id}"]` || s === `[data-theme='${id}']` || s === `:root[data-theme="${id}"]` || s === `html[data-theme="${id}"]`);
  for (const body of blocks(clean, ownSelector)) {
    for (const decl of splitDeclarations(body)) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (TOKEN_NAME.test(name) && safeTokenValue(value)) tokens.set(name, value);
    }
  }
  return tokens;
}

/** The pack's @font-face rules, rewritten to the font route; faces naming fonts the pack does not ship are dropped. */
export function fontFaces(css: string, pack: Pick<ThemePackForCss, 'id' | 'hasFont'>, fontBase: string): string[] {
  const clean = stripComments(css);
  const out: string[] = [];
  for (const body of blocks(clean, (sel) => sel === '@font-face')) {
    const decls: string[] = [];
    let src: string | null = null;
    for (const decl of splitDeclarations(body)) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (prop === 'src') {
        const parts: string[] = [];
        for (const m of value.matchAll(/url\(\s*["']?fonts\/([^"')\s]+)["']?\s*\)(\s*format\(\s*["']?woff2["']?\s*\))?/g)) {
          const file = m[1]!;
          if (FONT_FILE.test(file) && pack.hasFont(file)) parts.push(`url("${fontBase}${encodeURIComponent(pack.id)}/${encodeURIComponent(file)}") format("woff2")`);
        }
        if (parts.length > 0) src = parts.join(', ');
      } else if (['font-family', 'font-style', 'font-weight', 'font-display', 'font-stretch', 'unicode-range'].includes(prop) && /^[\w\s"',.+\-%]{1,200}$/.test(value)) {
        decls.push(`${prop}: ${value}`);
      }
    }
    if (src && decls.some((d) => d.startsWith('font-family'))) out.push(`@font-face { ${[...decls, `src: ${src}`].join('; ')}; }`);
  }
  return out;
}

/** Fallbacks for tokens a pack leaves out (mirrors the web app's pack default layer, simplified). */
function defaults(scheme: 'dark' | 'light'): Record<string, string> {
  const dark = scheme === 'dark';
  return {
    '--al-void': dark ? '#0b0d10' : '#f6f6f4',
    '--al-deep': 'var(--al-void)',
    '--al-text-1': dark ? '#eef1f4' : '#17191c',
    '--al-text-2': 'color-mix(in srgb, var(--al-text-1) 82%, var(--al-void))',
    '--al-text-3': 'color-mix(in srgb, var(--al-text-1) 66%, var(--al-void))',
    '--al-text-4': 'var(--al-text-3)',
    '--al-text-5': 'var(--al-text-4)',
    '--al-glass': 'color-mix(in srgb, var(--al-text-1) 6%, var(--al-void))',
    '--al-glass-strong': 'color-mix(in srgb, var(--al-text-1) 9%, var(--al-void))',
    '--al-field': 'color-mix(in srgb, var(--al-text-1) 5%, transparent)',
    '--al-tile': 'var(--al-deep)',
    '--al-line-1': 'color-mix(in srgb, var(--al-text-1) 10%, transparent)',
    '--al-line-2': 'color-mix(in srgb, var(--al-text-1) 16%, transparent)',
    '--al-line-3': 'color-mix(in srgb, var(--al-text-1) 24%, transparent)',
    '--al-cyan': '#00a4dc',
    '--al-cyan-ink': dark ? '#00131a' : '#ffffff',
    '--al-accent-text': 'var(--al-cyan)',
    '--al-nav-active-bg': 'color-mix(in srgb, var(--al-cyan) 14%, transparent)',
    '--al-nav-active-text': 'var(--al-accent-text)',
    '--al-track': 'color-mix(in srgb, var(--al-text-1) 12%, transparent)',
    '--al-warn': dark ? '#ffb45a' : '#b26a00',
    '--al-ok': dark ? '#6fe39a' : '#2f8a4a',
    '--al-danger': dark ? '#ff6b6b' : '#c4314b',
    '--al-radius-card': '8px',
    '--al-radius-control': '6px',
    '--al-radius-inner': 'var(--al-radius-control)',
    '--al-shadow-pop': dark ? '0 16px 40px rgba(0,0,0,.45)' : '0 16px 40px rgba(0,0,0,.18)',
    '--al-focus': '0 0 0 2px var(--al-void), 0 0 0 4px var(--al-cyan)',
    '--al-font': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    '--al-display': 'var(--al-font)',
  };
}

const IMP = ' !important';

/** Builds the Jellyfin stylesheet. `fontBase` is the URL prefix fonts are served under (`<fontBase><id>/<file>`). */
export function generateJellyfinCss(pack: ThemePackForCss, opts: { fontBase?: string } = {}): string {
  const fontBase = opts.fontBase ?? 'theme-fonts/';
  const tokens = parseThemeTokens(pack.css, pack.id);
  const faces = fontFaces(pack.css, pack, fontBase);
  const def = defaults(pack.colorScheme);
  const decl = (map: Iterable<[string, string]>) => [...map].map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const solid = (glass: string) => `background-color: var(--al-void)${IMP}; background-image: linear-gradient(${glass}, ${glass})${IMP}`;

  const rules: Array<[string, string]> = [
    // page
    ['html, body, .skinBody, .backgroundContainer:not(.withBackdrop)', `background-color: var(--al-void)${IMP}; color: var(--al-text-1)${IMP}`],
    // Item pages show the backdrop through a tinted layer: keep it see-through.
    ['.backgroundContainer.withBackdrop', `background-color: color-mix(in srgb, var(--al-void) 82%, transparent)${IMP}`],
    ['body, button, input, select, textarea, .emby-button, .cardText, .listItemBodyText', `font-family: var(--al-font)${IMP}`],
    ['h1, h2, h3, .sectionTitle, .pageTitle, .itemName, .headerTitle, .formDialogHeaderTitle', `font-family: var(--al-display)${IMP}; color: var(--al-text-1)${IMP}`],
    ['.secondaryText, .fieldDescription, .itemMiscInfo, .listItemBodyText.secondary, .itemDetailsGroup .label', `color: var(--al-text-3)${IMP}`],
    // header and drawer
    ['.skinHeader, .skinHeader-withBackground, .skinHeader.semiTransparent, .appfooter, .headerTabs', `background-color: var(--alj-header)${IMP}; color: var(--al-text-1)${IMP}`],
    ['.headerButton, .headerTabs .emby-tab-button, .pageTitle', `color: var(--al-text-1)${IMP}`],
    ['.mainDrawer, .mainDrawer-scrollContainer, .drawer-open .mainDrawer', `${solid('var(--al-glass)')}; color: var(--al-text-2)${IMP}; border-color: var(--al-line-1)${IMP}`],
    ['.navMenuOption, .navMenuOption .navMenuOptionIcon, .sidebarHeader', `color: var(--al-text-2)${IMP}`],
    ['.navMenuOption:hover, .navMenuOption-selected, .navMenuOption-selected .navMenuOptionIcon', `background-color: var(--al-nav-active-bg)${IMP}; color: var(--al-nav-active-text)${IMP}`],
    ['.navMenuOption', `border-radius: var(--al-radius-control)${IMP}`],
    // Jellyfin 12's React (MUI) shell: app bar, drawer, menus, tabs. MUI paints its own colours,
    // so the app bar text/icons must be set too or light packs end up with white-on-cream.
    ['.MuiAppBar-root', `background-color: var(--alj-header)${IMP}; color: var(--al-text-1)${IMP}`],
    ['.MuiAppBar-root .MuiButtonBase-root, .MuiAppBar-root .MuiIconButton-root, .MuiAppBar-root .MuiButton-root, .MuiAppBar-root .MuiTypography-root', `color: var(--al-text-1)${IMP}`],
    ['.MuiDrawer-paper, .MuiMenu-paper, .MuiPopover-paper, .MuiDialog-paper', `${solid('var(--al-glass-strong)')}; color: var(--al-text-1)${IMP}; border-color: var(--al-line-1)${IMP}`],
    ['.MuiListItemIcon-root, .MuiListSubheader-root, .MuiListItemText-secondary', `color: var(--al-text-3)${IMP}; background-color: transparent${IMP}`],
    ['.MuiListItemButton-root.Mui-selected, .MuiMenuItem-root.Mui-selected, .MuiListItemButton-root:hover, .MuiMenuItem-root:hover', `background-color: var(--al-nav-active-bg)${IMP}; color: var(--al-nav-active-text)${IMP}`],
    ['.MuiListItemButton-root, .MuiMenuItem-root', `border-radius: var(--al-radius-control)${IMP}`],
    ['.MuiTab-root', `color: var(--al-text-3)${IMP}`],
    ['.MuiTab-root.Mui-selected', `color: var(--al-accent-text)${IMP}`],
    ['.MuiTabs-indicator', `background-color: var(--al-cyan)${IMP}`],
    ['.MuiDivider-root', `border-color: var(--al-line-1)${IMP}`],
    // tabs
    ['.emby-tab-button', `color: var(--al-text-3)${IMP}`],
    ['.emby-tab-button-active, .emby-tab-button:hover', `color: var(--al-accent-text)${IMP}`],
    // cards
    ['.cardScalable, .cardContent, .cardImageContainer, .cardOverlayContainer, .cardImage, .listItemImage', `border-radius: var(--al-radius-card)${IMP}`],
    ['.cardImageContainer.defaultCardBackground, .defaultCardBackground', `background-color: var(--al-tile)${IMP}; color: var(--al-text-3)${IMP}`],
    ['.cardBox-bottompadded .cardFooter, .cardFooter', `color: var(--al-text-2)${IMP}`],
    ['.cardText', `color: var(--al-text-3)${IMP}`],
    ['.cardText-first, .cardText.cardTextCentered:first-child', `color: var(--al-text-1)${IMP}`],
    ['.cardOverlayContainer', `background-color: color-mix(in srgb, var(--al-void) 55%, transparent)${IMP}`],
    ['.cardOverlayButton, .cardOverlayButton-hover', `color: var(--al-text-1)${IMP}`],
    // lists and detail sections
    ['.listItem, .listItem-border, .paperList', `border-color: var(--al-line-1)${IMP}`],
    ['.paperList, .visualCardBox, .detailSection .paperList', `${solid('var(--al-glass)')}; border-radius: var(--al-radius-card)${IMP}`],
    // buttons
    ['.emby-button, .raised, .fab, .button-flat, .paper-icon-button-light', `border-radius: var(--al-radius-control)${IMP}`],
    ['.raised:not(.button-submit):not(.button-delete):not(.button-alt), .emby-button.raised:not(.button-submit):not(.button-delete)', `background-color: var(--alj-raised)${IMP}; color: var(--al-text-1)${IMP}; border-color: var(--al-line-2)${IMP}`],
    ['.button-submit, .emby-button.button-submit, .fab, .raised.button-submit, .btnPlay.detailButton', `background-color: var(--al-cyan)${IMP}; color: var(--al-cyan-ink)${IMP}; border-color: var(--al-cyan)${IMP}`],
    ['.button-submit:hover, .fab:hover', `background-color: color-mix(in srgb, var(--al-cyan) 86%, var(--al-text-1))${IMP}`],
    ['.button-delete', `background-color: var(--al-danger)${IMP}; color: #fff${IMP}`],
    ['.button-flat:hover, .paper-icon-button-light:hover, .listItem:hover, .actionSheetMenuItem:hover', `background-color: var(--alj-well)${IMP}`],
    ['.button-link, a.button-link, .sectionTitle a.button-flat, .textActionButton, .detailPageContent a:not(.emby-button)', `color: var(--al-accent-text)${IMP}`],
    // inputs
    ['.emby-input, .emby-select, .emby-select-withcolor, .emby-textarea, .emby-input-iconbutton', `background-color: var(--al-field)${IMP}; color: var(--al-text-1)${IMP}; border-color: var(--al-line-2)${IMP}; border-radius: var(--al-radius-control)${IMP}; font-family: var(--al-font)${IMP}`],
    ['.emby-input:focus, .emby-select:focus, .emby-select-withcolor:focus, .emby-textarea:focus', `border-color: var(--al-cyan)${IMP}; box-shadow: 0 0 0 3px color-mix(in srgb, var(--al-cyan) 25%, transparent)${IMP}`],
    ['.emby-select option, .emby-select-withcolor option', `background-color: var(--al-void)${IMP}; color: var(--al-text-1)${IMP}`],
    ['.inputLabel, .selectLabel, .textareaLabel, .checkboxListLabel, .inputLabelFocused', `color: var(--al-text-3)${IMP}`],
    ['.inputLabelFocused, .selectLabelFocused, .textareaLabelFocused', `color: var(--al-accent-text)${IMP}`],
    ['.checkboxOutline', `border-color: var(--al-text-3)${IMP}; border-radius: min(var(--al-radius-control), 6px)${IMP}`],
    ['.emby-checkbox:checked + span + .checkboxOutline, .emby-checkbox:checked + .checkboxOutline', `background-color: var(--al-cyan)${IMP}; border-color: var(--al-cyan)${IMP}`],
    ['.emby-checkbox:checked + span + .checkboxOutline .checkboxIcon-checked', `color: var(--al-cyan-ink)${IMP}`],
    // dialogs and action sheets
    ['.dialog, .actionSheet, .formDialog, .focuscontainer.dialog, .toast, .upNextDialog, .playerStats', `${solid('var(--al-glass-strong)')}; color: var(--al-text-1)${IMP}; border-color: var(--al-line-2)${IMP}; box-shadow: var(--al-shadow-pop)${IMP}`],
    ['.dialog, .actionSheet, .toast, .upNextDialog', `border-radius: var(--al-radius-card)${IMP}`],
    ['.formDialogHeader, .formDialogFooter, .dialogHeader', `${solid('var(--al-glass-strong)')}; color: var(--al-text-1)${IMP}; border-color: var(--al-line-1)${IMP}`],
    ['.actionSheetMenuItem, .actionsheetListItemBody, .actionSheetTitle', `color: var(--al-text-1)${IMP}`],
    ['.dialogBackdropOpened', `background-color: color-mix(in srgb, var(--al-void) 70%, transparent)${IMP}`],
    // player OSD
    ['.videoOsdBottom, .osdHeader, .skinHeader.osdHeader', `background-image: linear-gradient(to top, color-mix(in srgb, var(--al-void) 88%, transparent), transparent)${IMP}; background-color: transparent${IMP}; color: var(--al-text-1)${IMP}`],
    ['.osdControls .paper-icon-button-light, .osdTextContainer, .osdTitle, .osdSecondaryText', `color: var(--al-text-1)${IMP}`],
    // progress
    ['.itemProgressBar, .mdl-slider-background-flex, .mdl-slider-background-upper, .sliderBubble', `background-color: var(--al-track)${IMP}`],
    ['.itemProgressBarForeground, .mdl-slider-background-lower, .emby-slider-background-lower, .itemProgressBarForeground-recording', `background-color: var(--al-cyan)${IMP}`],
    ['.itemProgressBar, .itemProgressBarForeground, .mdl-slider-background-flex, .mdl-slider-background-lower', `border-radius: var(--al-radius-bar, 999px)${IMP}`],
    ['.playedIndicator, .countIndicator, .indicator', `background-color: var(--al-cyan)${IMP}; color: var(--al-cyan-ink)${IMP}`],
    ['.mdl-slider::-webkit-slider-thumb', `background-color: var(--al-cyan)${IMP}`],
    ['.mdl-slider::-moz-range-thumb', `background-color: var(--al-cyan)${IMP}`],
    // focus
    ['.card:focus-visible .cardBox, .card.show-focus:focus .cardScalable, .emby-button:focus-visible, .raised:focus-visible, .listItem:focus-visible, .navMenuOption:focus-visible', `box-shadow: var(--al-focus)${IMP}; outline-color: var(--al-cyan)${IMP}`],
    // scrollbars
    ['html', `scrollbar-color: var(--al-line-3) transparent`],
    ['::-webkit-scrollbar-thumb', `background-color: var(--al-line-3)${IMP}; border-radius: 999px`],
    ['::-webkit-scrollbar-track', `background-color: transparent${IMP}`],
    ['::selection', `background-color: color-mix(in srgb, var(--al-cyan) 35%, transparent); color: var(--al-text-1)`],
  ];

  return [
    `/* Arclight theme "${pack.name.replace(/\*\//g, '')}" ${pack.version} for Jellyfin Web (generated by Arclight, generator ${THEME_CSS_GENERATOR_VERSION}). */`,
    ...faces,
    `:root {\n  color-scheme: ${pack.colorScheme};\n${decl(Object.entries(def))}\n}`,
    tokens.size > 0 ? `:root {\n${decl(tokens)}\n}` : '',
    `:root {
  --alj-header: color-mix(in srgb, var(--al-void) 88%, transparent);
  --alj-raised: color-mix(in srgb, var(--al-text-1) 10%, var(--al-void));
  --alj-well: color-mix(in srgb, var(--al-text-1) 7%, transparent);
  --arclight-accent: var(--al-cyan);
  --arclight-surface: var(--al-void);
  --arclight-on-surface: var(--al-text-1);
  --arclight-radius: var(--al-radius-control);
  --arclight-ok: var(--al-ok);
  --arclight-warn: var(--al-warn);
}`,
    ...rules.map(([sel, body]) => `${sel} { ${body}; }`),
    '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}
