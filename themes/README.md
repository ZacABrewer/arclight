# Theme packs

Each folder here is a theme pack for the Arclight web app:

```
themes/
  index.json          generated, do not edit
  <id>/
    theme.json        manifest (id, name, version, colorScheme, backdrop, swatches)
    theme.css         every rule scoped under [data-theme="<id>"]
    fonts/*.woff2     optional, self-hosted
```

The folder name is the theme id and must match `id` in `theme.json`. `tron` is the built-in look
and is not a pack.

After changing a pack:

1. Bump `version` in its `theme.json`.
2. Run `node scripts/build-themes.mjs` to regenerate `index.json` (CI runs it with `--check`).
3. Commit and push. Running instances pick up the new version on their next sync.

Full guide, including the token list, validator rules and size limits:
[docs/THEMES.md](../docs/THEMES.md).
