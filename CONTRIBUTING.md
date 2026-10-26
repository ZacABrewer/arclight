# Contributing to Media-Tron

## Clean-room rule (read this first)

Media-Tron is a clean-room implementation. Sonarr, Radarr, Prowlarr, Bazarr, Seerr and other
upstream projects are **behaviour references only**. Read them to learn *what* happens;
write *how* yourself.

- **Never copy code, regexes, SQL or comments from upstream projects**, including
  paraphrases that follow their structure.
- Test inputs and expected values are data and may be used as fixtures.
- Pull requests that include upstream-derived code will be rejected.

The full rules are in [docs/CONVENTIONS.md](docs/CONVENTIONS.md); how to add modules and
contracts is in [docs/DEVELOPING.md](docs/DEVELOPING.md).

## Conventions

- TypeScript strict, ESM, Node 24; no `any` without a comment saying why.
- One package per concern; `packages/*` know nothing of the database or HTTP.
- Contract first: request/response shapes are Zod schemas in `packages/shared`.
- Commit messages: imperative subject up to 72 characters, body explains why.

## Running tests

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm build
```

Tests must not call live services; inject a fake `fetch`. CI runs the same commands plus a
Docker build on every pull request.
