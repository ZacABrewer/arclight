# Cloudflare and other browser challenges

Some indexer sites sit behind Cloudflare (or DDoS-Guard). Instead of a page, a plain HTTP
client gets a "Just a moment..." interstitial that only a real browser can pass. Arclight
deals with this in two layers. Both speak the same protocol, the FlareSolverr `/v1` JSON API,
so the indexer code does not care which one it uses.

## How a request flows

1. An indexer request goes out normally, through its HTTP/SOCKS5 proxy if it has one.
2. If the response is a challenge (status 403/503 from a `Server: cloudflare` / `ddos-guard`
   host with an interstitial body, or `error code: 1020`), Arclight sends the URL to the
   indexer's **FlareSolverr-type proxy** (`request.get`, or `request.post` for form logins).
3. The solver loads the page in a headless browser, waits until the challenge is gone, and
   returns the HTML, the cookies (including `cf_clearance`) and the browser's User-Agent.
4. Arclight stores the cookies in the indexer's cookie jar, caches the User-Agent per host and
   replays the original request with both. Later requests reuse them until Cloudflare asks
   again. `cf_clearance` only works with the same User-Agent and usually the same IP.

### Which proxy an indexer uses

- Its explicit proxy (Edit indexer → Proxy), if set.
- Otherwise every proxy that shares one of its tags. The auto-registered solvers carry the tag
  `cloudflare`, so tagging an indexer `cloudflare` routes it through them.
- Definition indexers whose definition sets `requiresFlareSolverr: true` also get the **first
  FlareSolverr proxy** (lowest id) appended automatically when none of the above is a solver.
  Definitions without the key behave as before.

## Layer 1: FlareSolverr container (Docker)

Every compose file under `docker/` runs `ghcr.io/flaresolverr/flaresolverr`:

| Layout | Network | Arclight reaches it at |
| --- | --- | --- |
| `docker-compose.yml`, `docker-compose.builtin.yml`, `docker-compose.release.yml` (VPN) | `network_mode: "service:gluetun"`: the solver's browser traffic leaves through the VPN with the same public IP as Arclight | `http://localhost:8191` |
| `docker-compose.novpn.yml`, `docker-compose.release.novpn.yml` | compose network | `http://flaresolverr:8191` |

Port 8191 is never published. The compose files pass the URL to Arclight as
`ARCLIGHT_FLARESOLVERR_URL`. On boot, and every 10 minutes after that (job
**ProxyAutoDetect**, also under System → Tasks), Arclight creates an indexer proxy named
**FlareSolverr (bundled)** tagged `cloudflare` when:

- no FlareSolverr-type proxy exists yet (the built-in solver below does not count), and
- `ARCLIGHT_FLARESOLVERR_URL` is set, or a FlareSolverr answers at `http://localhost:8191`.

It is created once. After that it is an ordinary proxy you can rename, retag or delete.
Deleting it while the env var is still set brings it back on the next run, so remove the env
var too if you don't want it. A FlareSolverr you run elsewhere works the same way: add it
under Settings → Indexers → Proxies (type FlareSolverr, host `http://nas`, port 8191).

## Layer 2: built-in solver (native Windows, macOS, Linux)

When Arclight runs directly on a machine (no Docker), there is usually no FlareSolverr, but
there is a browser. The built-in solver (`packages/challenge-solver`) drives it:

- **Browser discovery**: Edge (`%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`,
  then `%ProgramFiles%` and `%LOCALAPPDATA%`), Chrome, Brave, Chromium; the usual
  `/Applications` and `/usr/bin` paths elsewhere. Set `solver.browserPath` to override.
- **Isolation**: the browser runs `--headless=new` with its own profile in
  `<config>/solver-profile`. It never touches your everyday browser profile, and it runs
  alongside an open Edge/Chrome without interfering.
- **Protocol**: Arclight starts it with `--remote-debugging-port=0` (an ephemeral port bound to
  127.0.0.1), reads the DevTools endpoint from the startup output or the `DevToolsActivePort`
  file, and drives it over the Chrome DevTools Protocol with Node's built-in WebSocket. No
  Puppeteer and no extra dependencies.
- **Solving**: open a tab (one reusable tab per host, or per FlareSolverr `session`), navigate,
  then poll the page until it is no longer a challenge: no `cf-mitigated: challenge` header on
  the last document response, no interstitial title ("Just a moment...", "Attention
  Required!", DDoS-Guard), and no `_cf_chl_opt` / `__cf_chl_*` markers. Then it returns the
  FlareSolverr solution (`url`, `status`, `headers`, `response` HTML, `cookies`, `userAgent`).
  The headless `HeadlessChrome` token is removed from the User-Agent the page and the result
  see. POSTs run as `fetch()` inside the cleared page, so they carry its cookies.
- **Resources**: one request at a time (others queue). The browser starts on first use and
  closes after `solver.idleCloseSeconds` without work.

It is served by the api itself at `POST /api/v1/solver/v1` (same JSON as FlareSolverr's
`/v1`, behind the API key). When `solver.enabled` is on and a browser is found,
ProxyAutoDetect registers an indexer proxy **Built-in solver** (type FlareSolverr, host
`http://127.0.0.1/api/v1/solver`, the api's port, the API key stored as the proxy password and
sent as `X-Api-Key`) tagged `cloudflare`. It is kept in sync (API key rotation, port, timeout)
and removed when the solver is disabled or the browser disappears.

### Settings (`solver` section, `GET/PUT /api/v1/settings/solver`)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register and serve the built-in solver |
| `browserPath` | auto | Browser executable; empty = auto-detect |
| `timeoutSeconds` | `60` | Give up on a challenge after this long |
| `idleCloseSeconds` | `300` | Close the browser after this long idle (0 = keep it open) |

`GET /api/v1/solver/status` reports the browser found, whether it is running, the queue length
and the proxy id. `POST /api/v1/solver/autodetect` runs ProxyAutoDetect immediately.

## Which layer applies

| Situation | Solver used |
| --- | --- |
| Docker with the shipped compose files | FlareSolverr (bundled). The image has no browser, so the built-in solver stays unregistered. |
| Native Windows/macOS/Linux with a Chromium-family browser | Built-in solver |
| Native, and a FlareSolverr also answers on `localhost:8191` | Both get registered. Indexers use whichever applies by explicit proxy or tag; the definition default picks the lower id. |
| Neither | Nothing. Challenged indexers fail with a `CloudflareChallenge` error. |

## Health

**FlareSolverrUnreachable** (warning) is raised for every FlareSolverr-type proxy that does
not answer a cheap `sessions.list` (this never launches a browser). Testing a proxy
(`POST /api/v1/indexerproxy/:id/test`, the Test button) does more: it solves a real
`request.get`, by default for `https://example.com/` or for the URL you pass (an indexer's base
URL), so a solver whose own browser is broken fails the test too.

## Limits

- **Interactive challenges** (Turnstile "Verify you are human" checkboxes, CAPTCHAs) cannot be
  solved headlessly by either layer. Managed challenges often clear on their own in a real
  browser; interactive ones need a human. The built-in solver detects the Turnstile widget and
  says so in the timeout error.
- **Workaround for the built-in solver**: pass the challenge once by hand **in the same browser
  profile** (`<config>/solver-profile`). The `cf_clearance` cookie it earns is reused until it
  expires. Today that means starting the browser yourself with
  `--user-data-dir=<config>\solver-profile` while Arclight's solver browser is closed (or
  running `scripts/solver-smoke.mjs` with `ARCLIGHT_SOLVER_HEADFUL=1`). A future UI action,
  **"Open the site in the solver browser"** on the indexer page, will launch the solver profile
  with a visible window on that site and resume headless solving once you have passed it.
- **IP binding**: Cloudflare ties clearance to the IP that earned it. The bundled container
  shares the VPN with Arclight in the VPN layouts. The built-in solver uses the host's normal
  routing and ignores FlareSolverr's per-request `proxy` parameter, so an indexer that uses an
  HTTP/SOCKS proxy *and* the built-in solver may get cookies for a different IP.
- **Error 1020** ("Access denied") is a firewall block, not a challenge. It fails at once.
- FlareSolverr itself has been unreliable against recent Cloudflare changes at times. When
  both layers fail, the site needs cookies from a real session (definition `cookie` login).

## Manual smoke test

No automated test starts a real browser; they use a fake DevTools server. To check the
built-in solver against your installed browser:

```powershell
$env:ARCLIGHT_SOLVER_SMOKE = 1
pnpm --filter @arclight/challenge-solver smoke https://example.com/
```

Optional: `ARCLIGHT_SOLVER_BROWSER=<exe>` and `ARCLIGHT_SOLVER_HEADFUL=1`. The profile is kept
in `%TEMP%\arclight-solver-smoke`.
