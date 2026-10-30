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
echo "Arclight: checking ownership and permissions of /config (PUID $PUID, PGID $PGID)"
# Only touch what is wrong: a blanket chown -R / chmod -R rewrote every file on every start,
# minutes on a large config folder (image cache, backups) on spinning disks, with no output.
# Owning a folder is not enough when its mode bits deny the owner (NAS shared folders are often
# created as d--------- with ACLs on top), so give the owner read/write (and enter on folders) too.
find /config -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
find /config -xdev \( \( -type d ! -perm -u=rwx \) -o \( ! -type d ! -perm -u=rw \) \) -exec chmod u+rwX {} +
# /app is not chowned: it is read-only to the app, and changing owners there forced overlayfs to
# copy every image file into the container layer on each fresh start (minutes stuck in disk sleep).

if ! gosu "$PUID:$PGID" sh -c 'touch /config/.arclight-write-test && rm -f /config/.arclight-write-test'; then
  echo "Arclight cannot write to /config as $PUID:$PGID. Fix the host folder's permissions, e.g." >&2
  echo "  sudo chown -R $PUID:$PGID <host config folder> && sudo chmod -R u+rwX <host config folder>" >&2
  echo "or set PUID/PGID to a user that can write it." >&2
  exit 1
fi

# Give the app user the group that owns a device or socket so it can open it without running as
# root. $1 is the path, $2 the name for a group created when the GID has none in the container.
# Logs one line per group added.
ADDED_GROUPS=" "
add_owner_group() {
  owner_gid="$(stat -c '%g' "$1")"
  [ "$owner_gid" = "$PGID" ] && return 0
  case "$ADDED_GROUPS" in *" $owner_gid "*) return 0 ;; esac
  if ! getent group "$owner_gid" >/dev/null; then
    if getent group "$2" >/dev/null; then groupadd -g "$owner_gid" "$2-$owner_gid"; else groupadd -g "$owner_gid" "$2"; fi
  fi
  owner_group="$(getent group "$owner_gid" | cut -d: -f1)"
  usermod -aG "$owner_group" "$USER_NAME"
  ADDED_GROUPS="$ADDED_GROUPS$owner_gid "
  echo "$1 found: $USER_NAME added to group $owner_group ($owner_gid)"
}

# Self-update (Settings > Updates) talks to the Docker API through the socket when it is mounted
# (-v /var/run/docker.sock:/var/run/docker.sock). ARCLIGHT_DOCKER_SOCKET overrides the path.
SOCKET="${ARCLIGHT_DOCKER_SOCKET:-/var/run/docker.sock}"
if [ -S "$SOCKET" ]; then
  add_owner_group "$SOCKET" docker-sock
fi

# Hardware transcoding: /dev/dri (Intel/AMD VA-API, Quick Sync) and /dev/nvidia* nodes passed
# through with `devices:` are owned by the host's render/video group, which the app user is not in.
# Nodes anyone may already read and write (the NVIDIA ones usually are) need no group.
for dev in /dev/dri/* /dev/nvidia*; do
  [ -c "$dev" ] || continue
  case "$(stat -c '%A' "$dev")" in ???????rw?) continue ;; esac
  add_owner_group "$dev" render
done

# gosu sets supplementary groups only when given a user name without a group, so make PGID the
# primary group and switch by name.
usermod -g "$PGID" "$USER_NAME" >/dev/null 2>&1 || true
echo "Arclight starting as $USER_NAME:$GROUP_NAME ($PUID:$PGID)"
exec gosu "$USER_NAME" "$@"
