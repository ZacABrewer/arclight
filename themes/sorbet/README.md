# Sorbet

A light theme pack for Arclight: a warm cream page, white rounded cards on soft shadows, pill
buttons and inputs, and pastel fruit colours that each mean one thing:

| Fruit | Role |
| --- | --- |
| Strawberry | Actions, live progress (the accent) |
| Lime | Healthy, available, done |
| Lemon | Waiting, pending |
| Peach | Needs attention |
| Blueberry | In progress |
| Grape | People and requests |

Text on a pastel fill always uses that fruit's dark "ink" colour. Live downloads show moving
candy stripes; everything else stays still, and all motion stops when the system or Arclight's
own "Reduce motion" setting asks for it. The backdrop is three slowly drifting colour blobs
(`"backdrop": "shapes"`).

## Files

- `theme.json`: manifest.
- `theme.css`: the theme. Every rule is scoped to `[data-theme="sorbet"]`; it overrides the base
  `--al-*` tokens and reshapes components the tokens cannot reach.
- `fonts/`: Fredoka (display, 500/600), Nunito Sans (body, 400/600/700) and DM Mono (numbers,
  400/500), latin subsets as woff2, about 116 KB in total.

## Fonts and licence

All three typefaces are under the SIL Open Font License 1.1; the copyright notices and full
licence text are in `fonts/OFL.txt`. The woff2 files are unmodified copies from the
`@fontsource/fredoka`, `@fontsource/nunito-sans` and `@fontsource/dm-mono` packages (v5.3.0).
The theme CSS itself is part of Arclight and shares its licence.
