# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include the Arclight version (Settings > System, or the image tag),
how it is deployed (Docker, native), and the steps to reproduce. You will get an answer
in the advisory thread; fixes are released as a new image tag and credited in the release notes
unless you ask otherwise.

## Supported versions

Only the latest release (`:latest` / the newest `vX.Y.Z` tag) receives security fixes. The
`:develop` image follows the main branch and may contain unreleased changes.

## Hardening your install

- Keep the login enabled (Settings > Security) and use a long, unique password.
- Don't publish port 7878 straight to the internet. Use a reverse proxy with HTTPS, a Cloudflare
  Tunnel or a private network such as Tailscale; see
  [Exposing Arclight outside your home](docs/getting-started/exposing-outside-home.md).
- Treat the API key like a password: anyone with it controls Arclight. Regenerate it in
  Settings > Security if it leaks.
- Mounting the Docker socket (for automatic updates) gives Arclight root-equivalent control of
  the Docker host. Leave it unmounted unless you want that.
- Keep VPN credentials and API keys in your `.env` file, never in a compose file you share.
