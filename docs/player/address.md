# Player address

The player always answers at `/player` on your Arclight address, for example
`https://arclight.example.com/player`. Under **Settings > Player > Player address** you can give
it more addresses:

- **Paths**: extra paths that open the player on any hostname Arclight answers on, for example
  `/watch`. The player's pages sit below the path: `https://arclight.example.com/watch/music`.
- **Hostnames**: hostnames that show the player at their root, for example
  `watch.example.com`. The player's pages sit at the root too:
  `https://watch.example.com/watch/movies/12`, `https://watch.example.com/music`.

Each entry has **Open player** next to it, so you can check it right away. Save the page to keep
your changes.

## Player only

Every hostname has a **Player only** switch, on by default. On a player-only hostname, Arclight
serves only the player, the sign-in page (`/login`) and first-run setup (`/setup`). Any other
page, such as `/settings` or `/library/movies`, sends you back to the player, signed-in admins
included.

Turn **Player only** off to use the rest of Arclight on that hostname too. The player still
opens at the root, and its pages (`/music`, `/books`, `/search`, `/settings`, `/watch`, ...)
are the player's.

Player only hides the admin pages; it is not access control. The API checks every call by
itself, so keep using accounts and permissions as usual
([users and security](../using/users-and-security.md)).

## Where Arclight uses the player address

Arclight picks one public player address: the first hostname you added, else your Application
URL (Settings > Requests) plus the first extra path, else the Application URL plus `/player`.
That address is used for:

- **TV sign-in**: the TV shows `<player address>/link`, for example
  `watch.example.com/link`, and the QR code opens it.
- **Sign in a phone**: when there is a player hostname, the QR code points the app at that
  hostname.
- **Copy link** on title pages (see [the player in the browser](web.md#title-pages)).
- The player address returned by `GET /playback/me` (`playerUrl`), see the [API](../API.md).

A hostname uses the scheme of your Application URL, or `https` when none is set.

## Set up a player hostname

1. Point the hostname at Arclight: a DNS record for `watch.example.com`, and a site in your
   reverse proxy (or a public hostname in your tunnel) that forwards to the same Arclight address
   as your main one.
2. Keep the original `Host` header. Caddy, Traefik, Nginx Proxy Manager and Cloudflare Tunnel do
   this by default; plain Nginx needs `proxy_set_header Host $host;`.
3. In Arclight, open Settings > Player > Player address, add `watch.example.com` under
   **Hostnames** and save.
4. Open `https://watch.example.com`: the player opens at the root.

Caddy:

```
watch.example.com {
    reverse_proxy arclight:7878  # your Arclight address
}
```

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name watch.example.com;
    # ssl_certificate and ssl_certificate_key as for your main site

    location / {
        proxy_pass http://arclight:7878;  # your Arclight address
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Sign-ins are per hostname: signing in on `watch.example.com` does not sign you in on your main
address.

With `ARCLIGHT_BASE_PATH`, extra paths and hostnames sit below the base path, for example
`https://example.com/arclight/watch` and `https://watch.example.com/arclight/`. See
[sub-path hosting](../getting-started/sub-path-hosting.md).

## Player and request portal addresses

A path or hostname belongs either to the player or to the
[request portal](../using/discover-and-requests.md#public-request-portal), not both. Both
settings pages refuse an entry the other one already uses ("Already used by the request
portal", "Already used by the player"), and the server refuses to save one too
(`400 address-clash`). Case and a trailing dot on a hostname do not matter:
`Watch.Example.com.` and `watch.example.com` are the same hostname.

Paths Arclight uses itself, such as `/api`, `/settings` or `/library`, cannot be player paths.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| The hostname shows the full app, not the player | It is not under Hostnames, the settings were not saved, or the proxy changes the `Host` header |
| A page on the hostname jumps back to the player | **Player only** is on for that hostname |
| The TV still shows `/player/link` | No player address is set, or the Application URL is empty and there is no hostname |
| "Already used by the request portal" | That path or hostname is a portal address. Remove it there first |

## Related

- [The player in the browser](web.md)
- [Player](../using/player.md)
- [Exposing Arclight outside your home](../getting-started/exposing-outside-home.md)
- [Sub-path hosting](../getting-started/sub-path-hosting.md)
- [Arclight app](../using/arclight-app.md)
