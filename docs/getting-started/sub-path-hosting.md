# Hosting Arclight under a sub-path

This page shows how to serve Arclight below a path such as `https://example.com/arclight/` instead of on its own hostname. It is for people who already run a reverse proxy for several apps on one domain. If you can use a subdomain (`arclight.example.com`), that is still the simplest setup: see [Reaching Arclight from outside your home](exposing-outside-home.md), and do the hardening steps there either way.

## How it works

Set the environment variable `ARCLIGHT_BASE_PATH` to the path, for example `/arclight`, and restart Arclight. Everything then answers below that path:

| What | Address with `ARCLIGHT_BASE_PATH=/arclight` |
|---|---|
| The web app | `https://example.com/arclight/` |
| REST API | `https://example.com/arclight/api/v1/...` |
| Sonarr/Radarr-compatible API (for other apps) | `https://example.com/arclight/api/v3/...` |
| Live updates and live log (WebSockets) | `wss://example.com/arclight/api/v1/events`, `.../api/v1/log/stream` |
| Prometheus metrics | `https://example.com/arclight/metrics` |
| Request portal paths | `https://example.com/arclight/portal`, plus any extra portal paths you set |

Rules for the value:

- Leading slash, no trailing slash. `arclight/` is accepted and read as `/arclight`.
- Letters, digits, `.`, `_`, `~` and `-` in each segment; several segments (`/apps/arclight`) are fine.
- Empty or `/` means the root, which is the default.
- `..`, spaces, `?`, `#`, `%` and backslashes are refused: Arclight will not start and the log says why.

The proxy must forward the **full** path, prefix included. Do not strip `/arclight` at the proxy: Arclight removes it itself. Requests outside the prefix get a 404, except a request for `/`, which is redirected to `/arclight/`. `/arclight` without the trailing slash is redirected to `/arclight/` too.

The same Docker image works under any path: the path is read at start-up, not built into the image.

## Set the variable

In Docker Compose:

```yaml
services:
  arclight:
    # ... your existing Arclight service ...
    environment:
      - ARCLIGHT_BASE_PATH=/arclight
```

Then `docker compose up -d`. Outside Docker, set it like any other `ARCLIGHT_` variable before starting the server (see [install-other-platforms.md](install-other-platforms.md)).

If you open Arclight directly on the LAN afterwards, include the path too: `http://192.168.1.50:7878/arclight/`.

The health checks in the image and in the project's compose files read `ARCLIGHT_BASE_PATH` and call `/arclight/api/v1/system/ping`. If you wrote your own health check (for example in a Portainer stack or another orchestrator), add the path to its URL, or the container shows as unhealthy.

## Proxy examples

Every example uses `example.com` and an Arclight that listens on `192.168.1.50:7878`. Replace both. Each one keeps the prefix, passes WebSocket upgrades and sends the forwarded headers Arclight needs (`Host`, `X-Forwarded-For`, `X-Forwarded-Proto`).

### Nginx

```
server {
    listen 443 ssl http2;
    server_name example.com;
    # ssl_certificate and ssl_certificate_key lines go here

    location = /arclight/metrics { return 403; }

    # No trailing slash on proxy_pass: Nginx then forwards the path unchanged, prefix included.
    location /arclight/ {
        proxy_pass http://192.168.1.50:7878;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location = /arclight { return 301 /arclight/; }
}
```

Watch the `proxy_pass` line: `proxy_pass http://192.168.1.50:7878/;` (with a trailing slash) strips the prefix and the app will not load.

In Nginx Proxy Manager, add a Custom Location `/arclight` on the proxy host with the same forward host and port, and leave the forward path empty.

### Caddy

Caddy keeps the path and handles WebSockets by itself. Use `handle`, not `handle_path` (which strips the prefix):

```
example.com {
    @metrics path /arclight/metrics /arclight/metrics/*
    respond @metrics 403

    handle /arclight* {
        reverse_proxy 192.168.1.50:7878
    }
}
```

### Traefik (labels on a container)

A `PathPrefix` rule without a strip-prefix middleware forwards the full path. This sketch assumes an entrypoint named `websecure` and a certificate resolver named `letsencrypt`:

```yaml
services:
  arclight:
    # ... your existing Arclight service ...
    environment:
      - ARCLIGHT_BASE_PATH=/arclight
    labels:
      - traefik.enable=true
      - traefik.http.routers.arclight.rule=Host(`example.com`) && PathPrefix(`/arclight`)
      - traefik.http.routers.arclight.entrypoints=websecure
      - traefik.http.routers.arclight.tls.certresolver=letsencrypt
      - traefik.http.services.arclight.loadbalancer.server.port=7878
      # Block /arclight/metrics (higher priority than the main router)
      - traefik.http.routers.arclight-metrics.rule=Host(`example.com`) && PathPrefix(`/arclight/metrics`)
      - traefik.http.routers.arclight-metrics.priority=100
      - traefik.http.routers.arclight-metrics.entrypoints=websecure
      - traefik.http.routers.arclight-metrics.tls=true
      - traefik.http.routers.arclight-metrics.middlewares=arclight-deny
      - traefik.http.middlewares.arclight-deny.ipallowlist.sourcerange=127.0.0.1/32
      - traefik.http.routers.arclight-metrics.service=arclight
```

Do not add a `stripprefix` middleware. If Arclight is in Gluetun's network, put the labels on the gluetun container.

## Other apps and devices

Give the full address, path included, wherever something connects to Arclight:

| Client | What to enter |
|---|---|
| Arclight mobile app | `https://example.com/arclight` |
| Arclight Jellyfin plugin (Arclight URL) | `https://example.com/arclight` |
| Apps using the Sonarr/Radarr-compatible API | Host `example.com`, URL base `/arclight` (or the full URL `https://example.com/arclight`) |
| Settings > Requests > Application URL (links in notifications) | `https://example.com/arclight` |
| Prometheus scrape target | `metrics_path: /arclight/metrics` |

Request portal paths (`/portal`, `/watch`, ...) live below the base path: `https://example.com/arclight/watch`. A portal hostname (Settings > Requests > Public request portal) answers at the base path on that hostname, for example `https://requests.example.com/arclight/`.

The sign-in cookie keeps `Path=/`, so if you host two Arclight instances under different paths on the same hostname, signing into one signs you out of the other. Use separate hostnames for that.

## Checklist

1. `https://example.com/arclight/` shows the sign-in page, with styling and icons (that confirms the assets load).
2. `https://example.com/arclight/api/v1/system/ping` answers `{"status":"ok"}`.
3. After sign-in, the dashboard updates live (that confirms the WebSocket).
4. Reloading a deep page such as `https://example.com/arclight/activity/queue` shows that page, not a 404.
5. `https://example.com/arclight/metrics` gives 403 (or asks for credentials).

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Blank page or unstyled page under `/arclight/` | `ARCLIGHT_BASE_PATH` is not set (or Arclight was not restarted), or the proxy strips the prefix |
| `{"error":"not found","message":"Arclight is served under /arclight/"}` | The request reached Arclight without the prefix: the proxy strips it, or you opened the root address directly |
| Every page is a 404 from the proxy | The proxy rule does not match `/arclight/...`; check the location or path rule |
| The page loads but never updates | WebSocket upgrades are not forwarded for `/arclight/api/v1/events` |
| Arclight does not start, log mentions `ARCLIGHT_BASE_PATH` | The value has a character that is not allowed (see the rules above) |

## Related

- [exposing-outside-home.md](exposing-outside-home.md)
- [../using/users-and-security.md](../using/users-and-security.md)
- [install-docker.md](install-docker.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
