# Arclight brand

The "fast-forward" mark: two rounded chevrons with a blue-to-cyan gradient (`#2f7bff` → `#6ef6ff`), the back chevron at 45% opacity.

| File | Use |
|---|---|
| `mark-color.svg` | Primary mark on dark or light backgrounds |
| `mark-white.svg`, `mark-black.svg` | One-colour versions |
| `app-icon.svg`, `png/app-icon-*.png` | Rounded-square icon on the dark gradient tile (180 = apple-touch-icon, 192/512 = PWA, 1024 = App Store / Play source) |
| `png/mark-16/32/48.png` | Favicons |
| `lockup-dark-bg.svg`, `lockup-light-bg.svg` | Mark with the "Light Slice" ARCLIGHT wordmark (made by `intro/scripts/gen-lockups.mjs`) |
| `wordmark.ts`, `wordmark-path.ts` | The wordmark for the web and mobile apps' `Wordmark` components: the letters (generated from `intro/wordmark.svg` by `gen-lockups.mjs`) and the slice geometry, which widens the cut at small sizes so it still shows |

The wordmark is "Light Slice": Michroma letterforms (SIL Open Font License 1.1) as outlines, with a light line cut through the middle. Its source is `intro/wordmark.svg`; run `node intro/scripts/gen-lockups.mjs` after changing it. Headings and UI text use Chakra Petch 700 (SIL Open Font License).

Colours: background `#02070a` → `#0b1830`, text `#e9fdff`, accent `#6ef6ff`, primary `#2f7bff`.

The startup intro (`intro/`: the 6.1 s animation, its renderer, the rendered MP4s and the sound) uses the "Light Slice" wordmark (`intro/wordmark.svg`: Michroma letterforms as outlines, SIL Open Font License 1.1). The lockups above use the same wordmark; small places (favicons, app icons, compact headers) use the mark alone.
