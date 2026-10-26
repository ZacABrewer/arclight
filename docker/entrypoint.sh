#!/bin/sh
# Run as the PUID/PGID the user asked for so files written to /tv, /movies and
# /downloads are owned correctly on the NAS, the same convention linuxserver images use.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if ! getent group "$PGID" >/dev/null; then
  groupadd -g "$PGID" arclight
fi
GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"

if ! getent passwd "$PUID" >/dev/null; then
  useradd -u "$PUID" -g "$PGID" -d /config -s /usr/sbin/nologin -M arclight
fi
USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"

mkdir -p /config
chown -R "$PUID:$PGID" /config /app

# Self-update (Settings > Updates) talks to the Docker API through the socket when it is mounted
# (-v /var/run/docker.sock:/var/run/docker.sock). Give the app user the socket's group so it can
# open it without running as root. ARCLIGHT_DOCKER_SOCKET overrides the path.
SOCKET="${ARCLIGHT_DOCKER_SOCKET:-/var/run/docker.sock}"
if [ -S "$SOCKET" ]; then
  SOCK_GID="$(stat -c '%g' "$SOCKET")"
  if [ "$SOCK_GID" != "$PGID" ]; then
    if ! getent group "$SOCK_GID" >/dev/null; then
      groupadd -g "$SOCK_GID" docker-sock
    fi
    SOCK_GROUP="$(getent group "$SOCK_GID" | cut -d: -f1)"
    usermod -aG "$SOCK_GROUP" "$USER_NAME"
    echo "Docker socket $SOCKET found: $USER_NAME added to group $SOCK_GROUP ($SOCK_GID)"
  fi
  # gosu sets supplementary groups only when given a user name without a group, so make PGID the
  # primary group and switch by name.
  usermod -g "$PGID" "$USER_NAME" >/dev/null 2>&1 || true
  echo "Arclight starting as $USER_NAME:$GROUP_NAME ($PUID:$PGID)"
  exec gosu "$USER_NAME" "$@"
fi

echo "Arclight starting as $USER_NAME:$GROUP_NAME ($PUID:$PGID)"
exec gosu "$PUID:$PGID" "$@"
