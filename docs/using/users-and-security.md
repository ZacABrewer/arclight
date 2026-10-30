# Users and security

This page covers who can sign in to Arclight and how: login methods, user accounts and roles, the API key, sessions, what to do if you forget the admin password, running Arclight behind a reverse proxy, and how to expose it to the internet more safely. Everyone who has more than one person using Arclight, or who reaches it from outside the house, should read it.

All of the settings below live on one page: Settings > Security.

## Login methods

Under "Authentication" you choose how people sign in from a browser:

| Setting | Default | What it does |
|---|---|---|
| Method | Login page | **Login page**: a normal sign-in form. **Browser prompt (HTTP Basic)**: the browser shows its own username and password box. **None on the local network**: no sign-in for devices on your home network. |
| Require for local addresses | On | When on, even devices on your home network must sign in. Turn it off and requests from the same machine and the private network (192.168.x, 10.x and similar) skip sign-in. |
| Session length (days) | 30 | How long a sign-in lasts, 1 to 365 days. |

The API key always works for apps, whatever you choose here.

Local bypass applies only when both of these hold: the setup wizard is finished, and either the method is "None on the local network" or "Require for local addresses" is off. Arclight checks the address of the connection and every address in the `X-Forwarded-For` header; if any of them is a public address, sign-in is required. Public addresses always need credentials.

### Ways to sign in on the login page

- A local Arclight account (username and password).
- Your Jellyfin or Emby account, when a media server is connected ("Sign in with ..."). See [media-servers.md](media-servers.md).
- Plex ("Sign in with Plex"), through Plex's sign-in pin.

Admins always sign in with their Arclight username and password. A media-server sign-in never leads to an admin: see [Media-server accounts and admins](#media-server-accounts-and-admins).

### Who may sign in (Settings > Users > User defaults)

The same settings as the setup wizard's "User defaults" step:

| Setting | Default | What it does |
|---|---|---|
| Arclight accounts | On | Users may sign in with an Arclight username and password (login page and Basic). Off: only admins can. |
| Jellyfin, Emby, Plex | On | That media server may be used to sign in. The server's own "sign-in" switch under Settings > Media servers must be on too. |
| New people | Create an account on first sign-in | **Only people an admin added**: a media-server sign-in works only for accounts an admin created, imported or linked first. The server's "create users on sign-in" switch must also be on for automatic accounts. |
| Default request permissions, Default quotas | Request, Report issues; unlimited | The defaults of Settings > Requests, shown here too. |
| Default app access | Request portal only | Fixed; app access is granted per user. |

## Users and roles

Go to Settings > Security > Users. The first administrator is created in the setup wizard ([first-run-wizard.md](../getting-started/first-run-wizard.md)); until it exists, Arclight answers nothing but the wizard.

| Role | What they can do |
|---|---|
| Admin | Everything: dashboard, library, settings, users, indexers, download clients, system pages |
| User | The request portal: Discover, their own requests and issues, their account. Nothing else, unless you grant app access |

Add a user with "Add user". Usernames are 2 to 64 characters: letters, digits and `. _ @ -`. Passwords need at least 8 characters.

You can edit a user, reset their password ("Reset password": signs the user out everywhere) and delete them (their sessions end immediately). Rules: the last administrator cannot be demoted or deleted, you cannot delete yourself, and changing someone's role signs them out everywhere.

Request permissions, quotas and notification options for each user are separate: Settings > Users ("User settings"). See [discover-and-requests.md](discover-and-requests.md).

### App access

A user sees the request portal and nothing more: signing in takes them to `/portal`, and any app address (the dashboard, `/library`, `/settings` and so on) sends them back there. To let someone look at more, edit the user and set **App access** to "Request portal and parts of the app", then tick the areas:

| Area | What they can open (read-only) |
|---|---|
| Library | Series and movies lists and detail pages, collections |
| Calendar | The calendar |
| Activity | Queue, history and blocklist |
| Wanted | Missing, cutoff unmet and profile mismatch |

App access is read-only. Adding, editing, deleting, searching and every setting stay admin-only, and the api enforces this whatever the browser shows. The Users table shows each person's access ("Portal only", "Portal + Library", "Everything" for admins). People an admin gave the request or issue management permissions also get the Requests or Issues pages of the app.

### Media-server accounts and admins

- Signing in with Jellyfin, Emby or Plex only ever creates a `user` with the request portal, even for an administrator of that media server. The account has no Arclight password.
- An admin account cannot sign in through a media server ("admins sign in with their Arclight username and password"), and a media-server account cannot be linked to an admin, from the profile page or otherwise.
- To make a user an admin, edit them and choose the role Admin. If the account came from a media server (or an import), the editor asks for a password first; the api refuses the promotion without one. The promoted user is signed out everywhere and signs in again with that password.

To change your own password open your Profile page and use "Change password". That signs out your other sessions.

## The API key

The API key lets apps and scripts (Jellyfin plugins, scripts, a Sonarr-compatible tool) talk to Arclight. It grants admin access, so keep it private.

- Where: Settings > Security > "API keys" > "Admin API key". Use Show, Hide and Copy.
- Apps send it as the `X-Api-Key` header, or as `?apikey=` in the URL.
- To change it, click Regenerate and confirm "Regenerate API key?". Every app using the old key stops working until you give it the new one.
- Regenerate it if it was ever posted in a screenshot, log or support request.

## Sessions

Settings > Security > "Sessions" lists your sign-ins: Device, IP address, Signed in, Last seen and Expires. Click Revoke to end one; that browser is signed out on its next request. "This session" marks the one you are using.

Details:

- Signing in with "remember me" lasts for the session length and is extended while you keep using Arclight.
- Without "remember me" the browser cookie ends when you close the browser, and the server forgets it after one day.
- The cookie is named `al_session`. Only a hash of the token is stored in the database.
- The cookie is marked Secure when you use https (or when the proxy sends `X-Forwarded-Proto: https`).

## Forgot the admin password

There is no command-line or environment-variable reset. Pick whichever applies:

1. **Another admin exists**: that admin goes to Settings > Security > Users and uses "Reset password" on your account. The login page says the same: "Forgot your password? An admin can reset it under Settings > Users."
2. **You have a backup from before the password changed**: restore it ([backup-restore.md](../getting-started/backup-restore.md)).
3. **None of the above**: stop Arclight, move `arclight.db` out of the config folder, and start it again. You get the setup wizard and create a new admin. You lose settings and library data (the media files stay), so import your old database from a backup afterwards if you have one.

If you are locked out for another reason (rate limit, wrong auth method), see [Locked out](../TROUBLESHOOTING.md#locked-out).

## Rate limiting and lockout

After 10 failed sign-ins from one address within 15 minutes, Arclight answers with "Too many failed attempts. Wait a few minutes and try again." The counter covers the login page, media-server sign-in and HTTP Basic together. It is kept in memory, so it resets when Arclight restarts.

## Audit log

System > Audit records every change made through the API (creating, editing and deleting things) and every sign-in, successful or failed. Reads and tests are not recorded. You can filter, search and export to CSV. Details: [system.md](system.md#audit).

## Reverse proxy notes

Arclight is built to sit behind a reverse proxy (Nginx Proxy Manager, Caddy, Traefik, Nginx). It trusts the proxy's forwarded headers.

What your proxy must do:

| Requirement | Why |
|---|---|
| Forward `X-Forwarded-For` (the client address) | Rate limiting, the audit log and the local-network rule use it |
| Forward `X-Forwarded-Proto: https` | So the sign-in cookie is marked Secure |
| Allow websocket upgrades for `/api/v1/events` and `/api/v1/log/stream` | Live updates and the live log tail stop working otherwise |
| Forward the `Host` header | Normal behaviour for most proxies |

Important limits:

- Arclight is served at the root of its address (`/`). There is no base-URL setting, so a sub-path such as `https://example.com/arclight/` is not supported. Use a sub-domain (`arclight.example.com`).
- Port 7878 is the default. Point the proxy at `http://<your-host>:7878`.
- A proxy on the same machine looks like a local connection, but Arclight also checks the forwarded addresses, so a visitor from the internet is still treated as public.

## Exposing Arclight safely

The safest setup is to not expose it at all: use a VPN into your home network (for example WireGuard or Tailscale) and reach Arclight over that. If you must publish it, a Cloudflare Tunnel avoids opening a port on your router. Step-by-step guides for a reverse proxy, Cloudflare Tunnel and Tailscale are in [exposing-outside-home.md](../getting-started/exposing-outside-home.md).

Checklist before you expose anything:

- Keep Settings > Security > Method on "Login page" and "Require for local addresses" on.
- Put Cloudflare Access (or another identity check) in front of the hostname, so strangers never reach the Arclight login page.
- Use a long, unique admin password. Make every person a "User", not an "Admin", unless they need to manage settings. Users only reach the request portal.
- Never choose "None on the local network" while exposed.
- Do not publish the API key anywhere. Regenerate it if in doubt.
- Add a rule in Cloudflare to block the `/metrics` path from the internet. Do not block `/api/`: the web interface itself uses it.
- Leave "Allow /metrics without credentials" (Settings > General) off.
- Check System > Audit now and then for sign-ins you do not recognise.
- Keep Arclight updated ([updating.md](../getting-started/updating.md)).

Note: Cloudflare in front of Arclight is a different thing from Cloudflare protecting an indexer. If your indexers are blocked by Cloudflare challenges, see [Cloudflare and other browser challenges](../CLOUDFLARE.md).

## Searching users

A search box sits above the users table on Settings > Users once there is at least one. Every word you type has to match somewhere (in any order), case does not matter, and dots, dashes and underscores count as spaces. The count next to the box shows how many match ("2 of 9"), **Select all** then selects only the matching items, and Escape or **Clear search** shows everything again. The search is kept in the address (`?q=`). It matches the user name, the display name, the role and the permission and app-access text. Email addresses are not searched.

## Bulk actions

On Settings > Users, tick users to delete several at once (it asks first, with the count). Your own account and the last admin cannot be deleted; they are listed as failed in the result message.

## Related

- [Exposing Arclight outside your home](../getting-started/exposing-outside-home.md)
- [System pages](system.md)
- [Media servers](media-servers.md)
- [Discover and requests](discover-and-requests.md)
- [Back up and restore](../getting-started/backup-restore.md)
- [Locked out](../TROUBLESHOOTING.md#locked-out)
- [API reference](../API.md)
