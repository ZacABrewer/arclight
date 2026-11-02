#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds the plugin for every supported Jellyfin ABI, runs the unit tests, and packages the zips.
#   scripts/build.sh 1.0.0            # build + test + package
#   SKIP_TESTS=1 scripts/build.sh 1.0.0
#
# Needs the .NET 10 SDK (and the .NET 9 runtime to run the 10.11 tests). Without a local SDK:
#   docker run --rm -v "$PWD:/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 bash scripts/build.sh 1.0.0
set -euo pipefail

VERSION="${1:?usage: scripts/build.sh <version, e.g. 1.0.0>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/artifacts"
rm -rf "$OUT"
mkdir -p "$OUT/build"

build() { # <JellyfinTarget> <abiTag>
  local target="$1" tag="$2"
  echo "== Jellyfin $target"
  dotnet build "$ROOT/src/Jellyfin.Plugin.Arclight/Jellyfin.Plugin.Arclight.csproj" -c Release \
    -p:JellyfinTarget="$target" -p:ArclightVersion="$VERSION" \
    -o "$OUT/build/$tag" --nologo
  if [ -z "${SKIP_TESTS:-}" ]; then
    dotnet test "$ROOT/tests/Jellyfin.Plugin.Arclight.Tests/Jellyfin.Plugin.Arclight.Tests.csproj" -c Release \
      -p:JellyfinTarget="$target" -p:ArclightVersion="$VERSION" --nologo
  fi
}

build 12 12
build 10.11 11

node "$ROOT/scripts/package.mjs" --version "$VERSION" ${TIMESTAMP:+--timestamp "$TIMESTAMP"}
