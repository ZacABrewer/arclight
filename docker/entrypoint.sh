#!/bin/sh
# Run as the PUID/PGID the user asked for so files written to /tv, /movies and
# /downloads are owned correctly on the NAS, the same convention linuxserver images use.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if ! getent group "$PGID" >/dev/null; then
  groupadd -g "$PGID" mediatron
fi
GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"

if ! getent passwd "$PUID" >/dev/null; then
  useradd -u "$PUID" -g "$PGID" -d /config -s /usr/sbin/nologin -M mediatron
fi
USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"

mkdir -p /config
chown -R "$PUID:$PGID" /config /app

echo "Media-Tron starting as $USER_NAME:$GROUP_NAME ($PUID:$PGID)"
exec gosu "$PUID:$PGID" "$@"
