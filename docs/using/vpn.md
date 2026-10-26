# VPN and the kill switch

Arclight can watch your VPN, refuse to start downloads while it is down, and make its built-in torrent engine send all traffic through the tunnel. This page explains the three ways to connect a VPN (Gluetun in Docker, WireGuard for Windows, or an adapter you manage yourself), every setting on Settings > VPN, how Proton port forwarding works, what the kill switch does for each part of the system, and what each VPN-related health warning means. You need it if you download torrents and care that your home IP stays hidden. Usenet-only users can leave the VPN off.

Arclight does not provide a VPN. It uses one you already have and checks that it is doing its job.

## How protection works

There are two separate safety layers. Know which one you have.

| Layer | What it does | Where it is set |
|---|---|---|
| Network isolation (Docker) | Arclight runs inside Gluetun's network, so every connection leaves through the tunnel and Gluetun's firewall blocks everything else. If the tunnel drops, nothing gets out | The compose file (`network_mode: "service:gluetun"`) |
| Arclight's own guard | Checks the VPN every poll interval. When it is down or leaking, grabs are refused and the built-in engine pauses every torrent ("lockdown") | Settings > VPN and Settings > Torrent Engine |

With the shipped Docker stack both are active. On a native install (Windows, macOS, Linux without Docker) only Arclight's own guard exists, so set it up carefully and test it (see "Check that it works").

## Choosing a provider

Settings > VPN > **Provider**:

| Provider | For | What Arclight does |
|---|---|---|
| Gluetun (Docker) | The shipped Docker stacks | Reads status, public IP and the forwarded port from Gluetun's control server. The VPN itself runs in the Gluetun container |
| WireGuard for Windows (native) | Native Windows installs | Installs and watches a WireGuard tunnel service from a `.conf` file you provide (for example one downloaded from Proton). Can connect and disconnect it |
| Interface binding (any OS) | A VPN app you run yourself (the Proton VPN app, `wg0` on Linux) | Watches the adapter, and binds the torrent engine to its IPv4 address. Does not start or stop the VPN |

### Gluetun (Docker)

The shipped compose files (`docker/docker-compose.yml` and the others in `docker/`) already include Gluetun set up for ProtonVPN with WireGuard, port forwarding on, and the control server on port 8000. You mostly fill in `docker/.env` (copy it from `.env.example`):

| Variable | What it is |
|---|---|
| `PROTON_WIREGUARD_KEY` | The private key from a Proton WireGuard configuration created with "NAT-PMP (port forwarding)" ticked |
| `VPN_COUNTRIES` | Comma-separated Proton server countries (default `Netherlands`) |
| `LAN_SUBNET` | Your home network, such as `192.168.1.0/24`, so you can still reach the web UI through Gluetun's firewall |
| `GLUETUN_API_KEY` | Control-server key. Generate it with `scripts/gluetun-auth.sh` (or `scripts/gluetun-auth.ps1` on Windows), which also writes the auth file Gluetun needs and stores the key in `.env`. Restart the whole stack afterwards |

The compose file passes `ARCLIGHT_VPN_CONTROL_URL` (default `http://localhost:8000`) and `ARCLIGHT_VPN_API_KEY` to Arclight, so the Settings > VPN fields can stay empty. A value you type on the page wins over the environment variable. Full install steps are in [Install with Docker](../getting-started/install-docker.md).

| Setting | Default | What it does |
|---|---|---|
| Control server URL | `http://localhost:8000` (or `ARCLIGHT_VPN_CONTROL_URL`) | Gluetun's HTTP control server (`HTTP_CONTROL_SERVER_ADDRESS`). Because Arclight shares Gluetun's network, `localhost` is right in the shipped stacks |
| API key | empty (or `ARCLIGHT_VPN_API_KEY`) | Sent as `X-API-Key`. Leave empty only when the control server is open. Never shown again after saving |
| Username, Password | empty | Basic auth, for an older Gluetun or a reverse proxy that uses it instead of an API key |

Gluetun answers slowly when it is busy. Arclight allows up to three failed checks in a row, 15 seconds apart, before it believes the VPN is down, because Gluetun's own firewall already blocks traffic when its tunnel is down. During those re-checks the VPN page shows a warning ("Still treating the VPN as up") instead of an outage.

### WireGuard for Windows (native)

Install WireGuard for Windows, and get a `.conf` file from your provider.

| Setting | Default | What it does |
|---|---|---|
| WireGuard config (.conf) | empty | Path to the file, for example `C:\vpn\proton-nl.conf`. The file name without `.conf` is the tunnel name |
| Auto-start | On | Install the tunnel service when it is not running. Arclight retries at most every 5 minutes, and never after you pressed **Disconnect** |
| Kill switch | On | Block grabs and stop torrent traffic when the adapter disappears |
| WireGuard executable (advanced) | `C:\Program Files\WireGuard\wireguard.exe` | Only if WireGuard is installed elsewhere. `wg.exe` must sit next to it |

Arclight needs permission to install a Windows service for the tunnel, so run it as administrator, or start the tunnel yourself and turn Auto-start off. The status shows the endpoint, last handshake and transferred bytes. A handshake older than 3 minutes counts as a dead tunnel.

The page offers **Connect** and **Disconnect** buttons for this provider only.

### Interface binding (any OS)

| Setting | Default | What it does |
|---|---|---|
| Adapter name | empty | The VPN adapter's name as your OS shows it, for example `ProtonVPN` or `wg0` |

Arclight finds the adapter's IPv4 address, treats a missing adapter as "VPN down", and binds the torrent engine to that address. Because only the engine is bound, other Arclight traffic (indexer searches, metadata) still goes out normally.

## Other VPN providers

The shipped Docker files use ProtonVPN, but Gluetun supports many providers, for example Mullvad, AirVPN, Private Internet Access, Windscribe and NordVPN. Arclight does not care which one Gluetun uses. It only needs Gluetun's control server:

| Arclight needs | Gluetun endpoint | Used for |
|---|---|---|
| VPN running or stopped | `/v1/vpn/status` (older Gluetun: `/v1/openvpn/status`) | Connected or disconnected |
| Public IP and location | `/v1/publicip/ip` | Status page, leak check |
| Forwarded port (optional) | `/v1/portforward` (older Gluetun: `/v1/openvpn/portforwarded`) | Moving the torrent engine's listener |

Arclight tries the newer path first and falls back to the older one. If your provider has no port forwarding, the forwarded port stays empty and the engine uses its Listen port; that is not treated as an outage.

To switch provider, change the `gluetun` service in your compose file. The exact variable names depend on the provider, so copy them from the Gluetun wiki page for your provider rather than guessing:

| Compose setting | Change to |
|---|---|
| `VPN_SERVICE_PROVIDER` | Your provider's name as listed in the Gluetun wiki |
| `VPN_TYPE` | `wireguard` or `openvpn`, whichever your provider supports and you have credentials for |
| Credential variables (for Proton: `WIREGUARD_PRIVATE_KEY`) | The ones your provider's wiki page names, for example a WireGuard private key, or an OpenVPN user and password, set to `<your-key>` or `<your-user>` / `<your-password>` in `.env` |
| Server selection (for Proton: `SERVER_COUNTRIES`) | The provider's selection variables, such as countries or cities |
| `VPN_PORT_FORWARDING` | Keep `on` only if your provider supports forwarding; whether it does, and what extra variables it needs, varies by provider: check your provider and the Gluetun wiki |

Leave the rest alone: `HTTP_CONTROL_SERVER_ADDRESS`, `FIREWALL_OUTBOUND_SUBNETS`, the control-server API key, and `network_mode: "service:gluetun"` on Arclight and the other containers. Of the providers named above, this repository only ships and tests ProtonVPN. After changing the provider, recreate the stack, then check Settings > VPN shows Connected with a public IP that is not your home IP.

## Settings on Settings > VPN

| Setting | Default | What it does |
|---|---|---|
| VPN monitoring | Off | Master switch. Off means Arclight does nothing about the VPN: no checks, no guard. Turn it on once the provider is filled in |
| Provider | Gluetun | See above |
| Sync forwarded port (Gluetun only) | On | When Gluetun reports a forwarded port, set qBittorrent's listening port to it. Does not affect the built-in engine, which follows the port by itself (see below) |
| Pause grabs when down | On | Refuse new grabs while the VPN is down or leaking |
| Home public IP | empty | Your ISP address. If the VPN reports this as its public IP, traffic is leaking |
| Public IP check URL (advanced; native providers) | `https://api.ipify.org?format=json` | A web service that answers with your public IP, as JSON (`{"ip": "..."}`) or plain text. Gluetun reports its own public IP, so this is not used with Gluetun |
| Poll interval (advanced) | 60 seconds | How often to check the VPN, 10 to 3600 |

**Test** checks the form values without saving them. **Refresh** (in the Live status panel) checks right now. The Live status panel shows connected or disconnected (with the cause), public IP, location, forwarded port, uptime, endpoint, handshake and traffic, depending on the provider.

The native providers also have a fast watcher that looks at the adapter every 5 seconds, so a dropped tunnel is noticed within seconds rather than at the next poll.

### Home public IP: what it is for

Find your real address while the VPN is off, from your router's status page or a "what is my IP" site. Enter it here. If the VPN ever reports that same address, Arclight knows traffic bypasses the VPN and raises a leak. Use an address you have checked yourself, and update it if your ISP changes your address. Leave it empty to turn this one check off.

## Proton port forwarding

A forwarded port lets other peers connect to you, which means more peers and faster, more reliable downloads and seeding. Proton assigns the port dynamically. It can change when the tunnel reconnects.

1. When you create the WireGuard configuration on Proton's site, tick "NAT-PMP (port forwarding)", and use a Proton server that supports P2P.
2. The shipped Gluetun setup has `VPN_PORT_FORWARDING=on`. Nothing else to do there.
3. In Arclight: Settings > VPN, provider Gluetun, VPN monitoring on. Settings > Torrent Engine, Bind to VPN on.
4. Arclight reads the forwarded port from Gluetun on every poll. The built-in engine moves its listener to that port at once (the Listen port setting is then ignored; the Torrent Engine page shows "forwarded by VPN").
5. For a qBittorrent client, "Sync forwarded port" sets qBittorrent's listening port to match. If that fails for some client, the VPN status shows the port as not synced, and Arclight waits 10 minutes before retrying so it does not trigger qBittorrent's login lockout. A Remote Engine client follows the port only if you turn on **Follow VPN Port** on it; see [Download clients](download-clients.md).

With the native providers, Arclight cannot learn a forwarded port, so the engine uses the Listen port you set. If your provider hands you a fixed forwarded port, put it there.

If the port never shows up, see [Port forward not synced](../TROUBLESHOOTING.md#port-forward-not-synced).

## What the kill switch does

"Kill switch engaged" means the VPN is enabled, and either it is down or it is leaking, and a guard is on (Pause grabs when down, or the WireGuard kill switch). When that happens:

| Part | Behaviour |
|---|---|
| New grabs | Refused with "The VPN is down or not protecting traffic; grabs are paused until it reconnects". Searching still works. Grabs resume automatically when the VPN is back and no leak is reported |
| Built-in torrent engine (Bind to VPN on) | Enters **Lockdown**: every torrent is paused, and the listener and DHT are re-bound to `127.0.0.1`, so nothing can leave. When the VPN reconnects, sockets are re-bound to the tunnel and the torrents that were paused by the kill switch resume. Also triggered right after startup until the first VPN check has completed |
| Built-in engine (Bind to VPN off) | Not protected. Only the grab guard applies. The health check "Torrent engine is not bound to the VPN" tells you |
| qBittorrent, Transmission, Deluge, rTorrent, SABnzbd, NZBGet | Arclight cannot pause them. It only stops sending new grabs. Their safety depends on network isolation: run them in the same Gluetun network (`network_mode: "service:gluetun"`), or bind them to the VPN adapter in their own settings |
| Remote Engine | The agent has its own protection (`AGENT_LISTEN_INTERFACE`, and Gluetun on the seedbox). Arclight's guard only stops new grabs. See [Remote engine](../REMOTE-ENGINE.md) |
| Indexer searches, metadata, subtitles | In the shipped Docker stack they go through the tunnel too, because Arclight lives inside Gluetun's network. Natively they use your normal connection |

A leak counts as down: the same lockdown happens when your public IP equals the Home public IP.

> Coming soon: speed and VPN history charts. This page will be updated when they ship. For now the Live status panel shows the current state only.

## Health warnings

These appear under System > Health and as banners. Each links to [Troubleshooting](../TROUBLESHOOTING.md).

| Warning | What it means | Where to go |
|---|---|---|
| VPN is down | VPN monitoring is on and the tunnel is not connected. Grabs are paused if Pause grabs when down is on | [VPN disconnected](../TROUBLESHOOTING.md#vpn-disconnected). Check the Gluetun or WireGuard logs and credentials, then press Refresh |
| Traffic is not going through the VPN | The public IP equals your Home public IP: a leak | [VPN leak](../TROUBLESHOOTING.md#vpn-leak). Make Arclight and the client use the VPN (Gluetun network mode or interface binding) |
| Torrent engine is not bound to the VPN | The VPN integration is on but Bind to VPN is off, so torrent traffic can leave outside the tunnel | [Not on VPN](../TROUBLESHOOTING.md#torrent-engine-not-on-vpn). Turn on Bind to VPN |
| Torrent engine is locked down by the VPN kill switch | The VPN is down, leaking or not checked yet, so every torrent is paused and the engine listens only on 127.0.0.1. Resumes on its own | [Lockdown](../TROUBLESHOOTING.md#torrent-engine-lockdown). If the VPN is actually up, check that Arclight can reach Gluetun's control server |
| VPN kill switch keeps engaging | The kill switch paused the engine three or more times within an hour. Downloads crawl | [Kill switch flapping](../TROUBLESHOOTING.md#vpn-kill-switch-flapping). Look for real drops (provider, server, container restarts); if the VPN stays up, the status checks are failing |
| Torrent engine is not listening | No incoming connections are possible | [Not listening](../TROUBLESHOOTING.md#torrent-engine-not-listening). Check the port, and forward it on the router or through the VPN |

Other symptoms: [Paused by VPN kill switch](../TROUBLESHOOTING.md#paused-by-vpn-kill-switch) and [VPN won't connect](../TROUBLESHOOTING.md#vpn-wont-connect).

## Check that it works

1. Settings > VPN shows **Connected**, with a public IP that is not your home IP and (for Proton) a forwarded port.
2. Compare that public IP with what you see on a "what is my IP" site: they must differ from your home address.
3. Settings > Torrent Engine shows "Bound address" equal to the tunnel address (not "Not bound to the VPN"), and the listening port equals the forwarded port.
4. To test the kill switch, stop the Gluetun container (or press Disconnect on Windows). Within a poll the engine should go to Lockdown and Activity > Queue show torrents as paused. Start the VPN again and they resume.

## Related

- [Download clients](download-clients.md) (Bind to VPN, Lockdown, Remote Engine port following)
- [Indexers](indexers.md) (Cloudflare solver behind the VPN)
- [Install with Docker](../getting-started/install-docker.md)
- [Remote engine](../REMOTE-ENGINE.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
