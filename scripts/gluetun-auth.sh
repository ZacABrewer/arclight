#!/bin/sh
# Generates a Gluetun control-server API key, writes the auth config Gluetun needs, and stores
# the key in docker/.env so Arclight (ARCLIGHT_VPN_API_KEY) and Gluetun agree.
#
#   scripts/gluetun-auth.sh [CONFIG_ROOT]     default: value from docker/.env, else ./docker/data
#
# Re-running keeps an existing key. Restart the stack afterwards (docker compose down && up -d):
# containers that share Gluetun's network must be recreated when Gluetun restarts.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
envfile="$here/docker/.env"
[ -f "$envfile" ] || cp "$here/docker/.env.example" "$envfile"

root="${1:-}"
if [ -z "$root" ]; then
  root="$(grep -E '^CONFIG_ROOT=' "$envfile" | cut -d= -f2- || true)"
  root="${root:-$here/docker/data}"
fi

key="$(grep -E '^GLUETUN_API_KEY=' "$envfile" | cut -d= -f2- || true)"
if [ -z "$key" ]; then
  key="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -qE '^GLUETUN_API_KEY=' "$envfile"; then
    sed -i.bak "s/^GLUETUN_API_KEY=.*/GLUETUN_API_KEY=$key/" "$envfile" && rm -f "$envfile.bak"
  else
    printf 'GLUETUN_API_KEY=%s\n' "$key" >> "$envfile"
  fi
  echo "Generated GLUETUN_API_KEY in $envfile"
else
  echo "Keeping existing GLUETUN_API_KEY from $envfile"
fi

mkdir -p "$root/gluetun/auth"
cat > "$root/gluetun/auth/config.toml" <<EOF
# Written by scripts/gluetun-auth.sh. Arclight reads status, public IP and the forwarded port.
[[roles]]
name = "arclight"
routes = ["GET /v1/publicip/ip", "GET /v1/vpn/status", "GET /v1/openvpn/status", "GET /v1/portforward", "GET /v1/openvpn/portforwarded"]
auth = "apikey"
apikey = "$key"
EOF
echo "Wrote $root/gluetun/auth/config.toml"
