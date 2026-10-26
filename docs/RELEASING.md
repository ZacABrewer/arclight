# Releasing Arclight

Releases are cut by pushing a `vX.Y.Z` tag; `.github/workflows/release.yml` does the rest.

## Cut a release

```sh
git switch main && git pull
node scripts/bump-version.mjs 0.2.0     # root, apps/api, apps/web package.json
git commit -am "Release v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

CI on the tag builds a multi-arch (linux/amd64, linux/arm64) image, pushes it to
`ghcr.io/<owner>/arclight` with SBOM and provenance attestations, and creates a GitHub
Release with generated notes plus the compose files and `.env.example`. A tag containing a
hyphen (`v0.2.0-rc.1`) is marked as a pre-release.

## Image tags

| Tag | Meaning |
| --- | --- |
| `vX.Y.Z` | Exact release (reported as `ARCLIGHT_VERSION` = `X.Y.Z`) |
| `X.Y` | Latest patch of that minor |
| `latest` | Most recent tagged release |
| `develop` | Every push to `main` (unreleased, may break) |

## Run from the published image

Download `docker-compose.release.yml` (Gluetun/ProtonVPN) or
`docker-compose.release.novpn.yml` and `.env.example` from the Release, rename
`.env.example` to `.env`, fill it in, then:

```sh
docker compose -f docker-compose.release.yml up -d          # with VPN
docker compose -f docker-compose.release.novpn.yml up -d    # without VPN
```

These are the source-build files with `build:` replaced by
`image: ${ARCLIGHT_IMAGE:-ghcr.io/zacheryabrewer/arclight:latest}`. Set `ARCLIGHT_IMAGE` in
`.env` if your image lives under a different owner. Upgrade with
`docker compose pull && docker compose up -d`.

## Roll back

Pin the previous tag in `.env` and recreate:

```sh
ARCLIGHT_IMAGE=ghcr.io/<owner>/arclight:v0.1.0
docker compose -f docker-compose.release.yml up -d
```

The database in `/config` is migrated forward on start and migrations are not reversed, so
back up `/config` before upgrading if you may need to roll back.
