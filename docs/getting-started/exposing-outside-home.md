# Reaching Arclight from outside your home

This page explains the ways to use Arclight when you are away from home, or to share it with family who are, and how to do it without putting your media server at risk. It is for anyone who wants a link they can open on a phone or at a friend's house. The short version: a private VPN into your home network is the safest option; a reverse proxy or a Cloudflare Tunnel is fine if you lock things down first.

## Choose an approach

| Option | Safety | Effort | Good for |
|---|---|---|---|
| Do nothing (LAN only) | Safest | None | Everyone at home |
| VPN into your home (WireGuard, Tailscale) | Very safe | Low | You and a few trusted people |
| Cloudflare Tunnel | Good if you add an access rule | Medium | A public hostname without opening a router port |
| Reverse proxy (Caddy, Traefik, Nginx Proxy Manager) | Good if hardened | Medium | A public hostname you control |
| Forward port 7878 straight to the internet | Do not do this | | Never use plain HTTP over the internet |

## Do these first, whatever you choose

Do them before you open anything. All settings are under Settings > Security unless noted. Full reference: [users-and-security.md](../using/users-and-security.md).

1. Use a long, unique admin password. Passwords need at least 8 characters; use far more. Make family members "User", not "Admin".
2. Set Authentication > Method to "Login page". Never choose "None on the local network" on anything reachable from outside.
3. Keep "Require for local addresses" on (the default). Then even a local-looking connection needs to sign in.
4. Keep "Allow /metrics without credentials" (Settings > General) off. `/metrics` is a Prometheus status page at the root of Arclight; it needs the same credentials as the API unless you switch that on.
5. Treat the Admin API key as a password and regenerate it if it ever appears in a screenshot or log. Settings > Security > API keys.
6. After sign-in, glance at System > Audit now and then for sign-ins you do not recognise.
7. Update regularly: [updating.md](updating.md).

Never expose these to the internet:

| Port or path | Why |
|---|---|
| qBittorrent web UI (8080) | Full control of your downloads, often weak or default login |
| Gluetun control server (8000) | VPN status and control; it is meant for Arclight only |
| FlareSolverr (8191) | An open browser that fetches any URL for anyone; the compose files never publish it |
| The Docker socket | Root-equivalent control of the host |
| `/metrics` | Status information; block it at the proxy |
| Torrent peer ports | Only open them if you want incoming peers; they are separate from the web UI and do not expose Arclight |

If Arclight runs inside Gluetun's network, the web port is published on the gluetun container; your proxy should point at the host and port 7878 there.

## How Arclight sees a proxy

- It always trusts the standard forwarded headers: there is no "trusted proxy" setting to switch on.
- The proxy must send `X-Forwarded-For` (the real client address) and `X-Forwarded-Proto: https` so the sign-in cookie is marked Secure. Caddy, Traefik and Nginx Proxy Manager do this by default; a plain Nginx config needs the lines shown below.
- For the "local address" rule, Arclight checks the connection and every address in `X-Forwarded-For`. If any is public, sign-in is required. A proxy on the same machine therefore does not turn internet visitors into local users.
- Two paths need WebSocket upgrades or the page looks stuck: `/api/v1/events` (live updates) and `/api/v1/log/stream` (live log).
- Arclight lives at the root of its address. There is no base-URL setting, so `https://example.com/arclight/` does not work. Use a subdomain such as `arclight.example.com`.

## Option 1: do nothing

Stay on the LAN. Away from home you simply cannot reach it. This is a valid choice if only you need it.

## Option 2: VPN into your home (recommended)

A VPN gives your phone or laptop a private path to your home network. Nothing is published, so there is nothing for strangers to find.

- **Tailscale:** install it on the machine that runs Arclight (or on another always-on device in your home) and on your phone or laptop, sign in to the same Tailscale account, then browse to `http://<tailscale-name-or-ip>:7878`. To share with family, invite them to your Tailscale network, or share just that machine, according to Tailscale's own documentation.
- **WireGuard on your router or NAS:** many routers and NAS systems can host a WireGuard server. Connect your phone to it and use the machine's normal home address, `http://192.168.1.x:7878`.

Hints:

- If you use Arclight's own VPN (Gluetun) for downloads, that is a different tunnel. Tailscale or a home VPN server are for reaching in; Gluetun is for torrent traffic going out. Do not put Tailscale into the Gluetun container.
- Use HTTP over a VPN: traffic is already encrypted inside the tunnel.

## Option 3: reverse proxy

You need a domain name pointing at your home, ports 80 and 443 forwarded to the proxy machine, and (with a dynamic home IP) a dynamic DNS updater. In every example below, replace `arclight.example.com` and `192.168.1.50`, and use the real host and port where Arclight listens.

### Caddy

Caddy gets and renews HTTPS certificates itself and proxies WebSockets without extra configuration. A `Caddyfile`:

```
arclight.example.com {
    # Block the metrics page from the internet
    @metrics path /metrics /metrics/*
    respond @metrics 403

    reverse_proxy 192.168.1.50:7878
}
```

### Traefik (labels on a container)

Add labels to a container on the same Docker network as Traefik. This sketch assumes an entrypoint named `websecure` and a certificate resolver named `letsencrypt` in your Traefik config. Traefik handles WebSockets automatically.

```yaml
services:
  arclight:
    # ... your existing Arclight service ...
    labels:
      - traefik.enable=true
      - traefik.http.routers.arclight.rule=Host(`arclight.example.com`)
      - traefik.http.routers.arclight.entrypoints=websecure
      - traefik.http.routers.arclight.tls.certresolver=letsencrypt
      - traefik.http.services.arclight.loadbalancer.server.port=7878
      # Block /metrics (higher priority than the main router)
      - traefik.http.routers.arclight-metrics.rule=Host(`arclight.example.com`) && PathPrefix(`/metrics`)
      - traefik.http.routers.arclight-metrics.priority=100
      - traefik.http.routers.arclight-metrics.entrypoints=websecure
      - traefik.http.routers.arclight-metrics.tls=true
      - traefik.http.routers.arclight-metrics.middlewares=arclight-deny
      - traefik.http.middlewares.arclight-deny.ipallowlist.sourcerange=127.0.0.1/32
      - traefik.http.routers.arclight-metrics.service=arclight
```

If Arclight is in Gluetun's network, put the labels on the gluetun container, because that is the one with the network and port.

### Nginx Proxy Manager

1. Proxy Hosts > Add Proxy Host.
2. Domain Names: `arclight.example.com`. Scheme `http`, Forward Hostname / IP `192.168.1.50`, Forward Port `7878`.
3. Turn on Websockets Support, and Block Common Exploits.
4. On the SSL tab: request a new certificate, turn on Force SSL and HTTP/2.
5. On the Advanced tab (custom Nginx configuration), block metrics:

   ```
   location /metrics {
       return 403;
   }
   ```

Menu labels may differ slightly by version.

### Plain Nginx

```
server {
    listen 443 ssl http2;
    server_name arclight.example.com;
    # ssl_certificate and ssl_certificate_key lines go here

    location = /metrics { return 403; }

    location / {
        proxy_pass http://192.168.1.50:7878;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

### Checklist after setting up a proxy

1. `https://arclight.example.com` shows the sign-in page, not the dashboard.
2. `https://arclight.example.com/metrics` gives 403 (or at least asks for credentials).
3. After sign-in, the dashboard updates live (that confirms WebSockets).
4. Settings > Security > Sessions shows your real address, not the proxy's. If it shows the proxy's, forwarded headers are not being sent.
5. From a phone on mobile data, the site loads and port 7878 itself is not reachable.
6. Consider an extra login layer in front (your proxy's basic auth, or an identity provider), so strangers never see Arclight's own page.

## Option 4: Cloudflare Tunnel

A tunnel makes an outbound connection from your network to Cloudflare, so you open no port on your router. Steps (summary; the exact flow is on Cloudflare's site):

1. Create a tunnel in the Cloudflare Zero Trust dashboard and run `cloudflared` on a machine that can reach Arclight.
2. Add a public hostname such as `arclight.example.com` pointing at `http://192.168.1.50:7878`.
3. Add a Cloudflare Access policy so only people you allow can reach the hostname at all, and add a rule to block the `/metrics` path.
4. Do not block `/api/`: the web interface itself uses it.
5. Check that the sign-in page works and that live updates arrive.

Full hardening steps for this setup are in [users-and-security.md](../using/users-and-security.md#exposing-arclight-safely). Note that [CLOUDFLARE.md](../CLOUDFLARE.md) is about something different: it explains how Arclight gets past Cloudflare challenges when it talks to indexers. A tunnel is Cloudflare in front of Arclight; that page is Cloudflare in front of an indexer.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Page loads but never updates | WebSockets not allowed for `/api/v1/events` |
| Redirect loop after sign-in | The proxy does not send `X-Forwarded-Proto: https` |
| Blank page under `/arclight/` | Sub-paths are not supported; use a subdomain |
| Everyone sees "Too many failed attempts" | The proxy hides client addresses, so all users share one counter. Send `X-Forwarded-For` |
| You locked yourself out | See [locked out](../TROUBLESHOOTING.md#locked-out) |

## Related

- [../using/users-and-security.md](../using/users-and-security.md)
- [../CLOUDFLARE.md](../CLOUDFLARE.md)
- [install-docker.md](install-docker.md)
- [updating.md](updating.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
