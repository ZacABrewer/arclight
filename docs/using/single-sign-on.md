# Single sign-on, two-factor and API keys

This page covers the extra ways to sign in to Arclight and to protect an account: signing in through an identity provider you already run (OpenID Connect), trusting a login proxy in front of Arclight (forward-auth), two-factor sign-in with an authenticator app or a passkey, and per-user API keys. Everything here is optional. If you have one or two users on a home network, the normal password login described in [Users and security](users-and-security.md) is enough.

Provider and proxy settings are on Settings > Security and need an admin. Two-factor and API keys are on each person's own Profile page.

## Which one do I need?

| I want to... | Use |
|---|---|
| Let people sign in with the same account they use for other self-hosted apps | [OpenID Connect](#openid-connect-sign-in) |
| Put a login proxy (Authelia, Authentik proxy, and so on) in front of Arclight and skip the Arclight login | [Forward-auth](#forward-auth-trusted-header-sign-in) |
| Protect local passwords with a second step | [Two-factor](#two-factor-for-local-accounts) |
| Sign in without a password | [Passkeys](#passkeys) |
| Give a script or app its own revocable key | [Per-user API keys](#per-user-api-keys) |

## OpenID Connect sign-in

Go to Settings > Security > Sign-in / identity providers. You can add up to 10 providers. Each one becomes a "Sign in with <name>" button on the login page.

### Settings for a provider

| Field | What it does |
|---|---|
| id | A lowercase slug such as `authentik`. It is used in the redirect address, so pick it once and keep it. |
| name | The text of the button: "Sign in with <name>". |
| enabled | Off hides the button and refuses sign-ins through it. |
| issuer | The provider's issuer address, or its `/.well-known/openid-configuration` address. The issuer the provider reports must match exactly (a trailing slash does not matter). |
| client id, client secret | From the provider. An empty secret means a public client (PKCE only). A saved secret is shown as `********`; sending that mask back keeps the stored secret. |
| scopes | Default `openid email profile`. `openid` is always added. Add `groups` for providers that only send groups when asked. |
| matchBy | `email`: an existing account is matched by verified email. `none`: never match, only link or create. |
| trustUnverifiedEmail | Treat the email as verified even if the provider does not say so. Leave off unless you control the provider and know it checks emails. |
| autoCreate | Create an Arclight account the first time someone signs in. |
| defaultRole | Role for created accounts: `user` or `admin`. Keep this on `user`. |
| groupsClaim | Name of the groups entry in the token. Default `groups`. |
| adminGroups | Members become admins at every sign-in; everyone else becomes a `user`. Empty means roles are not synced. The last admin is never demoted. |
| allowedGroups | When set, only members of these groups (and of the admin groups) may sign in. |
| usernameClaim | Where the username comes from. Default `preferred_username`; if that is missing Arclight uses the part of the email before the `@`, then the provider's subject. |
| showOnLogin | Show the button on the login page. |
| showOnPortal | Show it on the request portal's sign-in too. |

The **Test** button fetches the provider's discovery document and tells you if the issuer is wrong or unreachable. It does not sign anyone in.

### The redirect address

Register this address at your provider as the redirect (callback) URI:

```
https://arclight.example.com/api/v1/auth/oidc/<id>/callback
```

With [sub-path hosting](../getting-started/sub-path-hosting.md) the prefix is part of it:

```
https://example.com/arclight/api/v1/auth/oidc/<id>/callback
```

Arclight shows the exact value next to each provider. It builds it from Settings > Requests > Application URL when that is set, and from the address your browser used otherwise. If the provider says "redirect URI mismatch", set the Application URL and copy the value again.

### How a sign-in works

1. You click the button. Arclight sends your browser to the provider with a one-time `state`, a `nonce` and a PKCE challenge (S256), and sets a short-lived cookie named `al_oidc` (10 minutes) that ties the attempt to that browser.
2. You sign in at the provider and come back to the callback address. The `state` can be used once.
3. Arclight exchanges the code for tokens and checks the ID token: the signature against the provider's published keys (RSA, PSS, ECDSA or EdDSA; HS256 only when there is a client secret; `none` is never accepted), the issuer, the audience, the authorized party, the expiry (60 seconds of clock tolerance) and the nonce.
4. Arclight asks the provider's userinfo endpoint for extra claims. Its subject must match the token's.
5. Arclight maps the person to an account and opens a session.

Arclight authenticates to the provider with HTTP Basic client credentials, or in the request body if that is the only method the provider advertises.

### Which account do you get

Arclight tries these in order and stops at the first that applies:

1. An existing link between this provider and this person (the provider's subject).
2. With `matchBy` set to `email`: a **verified** email that matches exactly one **non-admin** account whose own email is verified too. The account is linked for next time.
3. With `autoCreate` on: a new account.
4. Otherwise the sign-in is refused (`no_account`).

Admin accounts are never matched by email, because a provider that lets people change their email would otherwise be a way to become admin. An admin links their provider account on purpose: Profile > Linked sign-ins > Link.

An account's email counts as verified when an admin set it (Settings > Users), when a provider that verified that address signed the account in or was linked to it, or when the account existed before 0.24. When people change their own email on their Profile, it stops counting as verified, so typing someone else's address into a profile cannot capture their first provider sign-in. Arclight also refuses a self-set email that another account already uses. To make a changed email match again, an admin saves it on the user's page, or the person links the provider from their Profile once.

Accounts that a provider created have no usable password. They sign in through the provider (or add a passkey).

### Linking and unlinking

On your Profile page, "Linked sign-ins" lists your providers with Link and Unlink. You cannot remove your last way in: unlinking is refused if you would have no password, no other link and no passkey left. An admin can unlink a provider for any user from that user's page.

### Roles from groups

With `adminGroups` set, Arclight re-checks groups at every sign-in: members of an admin group become admins, everyone else becomes a `user`. It never demotes the last admin, so a typo cannot lock everyone out. With `allowedGroups` set, people outside those groups (and outside the admin groups) are refused with `forbidden`. Make sure the provider actually puts groups in the token; many need the `groups` scope.

### Sign-in errors

A failed sign-in returns to the login page with a message. The codes (`ssoError` in the address) mean:

| Code | Meaning |
|---|---|
| `state` | The attempt expired, was already used, or was started in another browser. Try again from the login page. |
| `provider` | The provider was unreachable or refused the request. Check the issuer, client id and secret, and the redirect address. |
| `token` | The provider's token was rejected (wrong audience, issuer, signature, nonce or expired). Check the clock on both servers. |
| `no_account` | No account matched and `autoCreate` is off. |
| `forbidden` | The person is not in `allowedGroups`, or an admin account matched by email (admins must link from their profile). |
| `disabled` | The account is disabled. |
| `link_conflict` | That provider account is already linked to a different Arclight account. |
| `rate_limited` | Too many sign-ins were started from this address, or too many are unfinished. Wait a few minutes. Each address may start about 20 in a burst, then one every 10 seconds, and hold at most 20 unfinished ones. |

### Two-factor and sessions

A session opened by a provider shows `oidc:<id>` as its method in Settings > Security > Sessions. Arclight does not ask for its own two-factor code after a provider sign-in: have the provider enforce multi-factor.

### Hiding the password form

Turn on `hidePasswordLogin` to hide the username and password form whenever a provider button is shown. If the provider is down or misconfigured you are not locked out:

- Open `/login?local=1` (under a sub-path, `/arclight/login?local=1`) to get the password form back.
- The API always still accepts the local admin password, so an admin can reach Arclight even if the provider is down.
- If everything else fails, see [Forgot the admin password](users-and-security.md#forgot-the-admin-password).

### The mobile app

The Arclight mobile app shows the server's web interface inside the app. Google and some other providers refuse OAuth sign-in inside an embedded web view. In the app, sign in with a password or a passkey, or use a provider that allows it. See [Mobile app](mobile-app.md).

## Example provider setups

These are sketches. Menu names in each product change between versions, so treat the names below as "roughly". In every case: use `arclight.example.com` and `auth.example.com` as stand-ins for your own addresses, set the redirect address from above, and paste the issuer, client id and secret into Arclight, then press Test.

### Authentik

Roughly: Applications > create an application and a provider of type OAuth2/OpenID.

- Client type: confidential. Copy the client id and secret.
- Redirect URI: `https://arclight.example.com/api/v1/auth/oidc/authentik/callback` (with the id you chose).
- Scopes: openid, email and profile, plus whatever makes the provider include a groups claim.
- Issuer in Arclight: `https://auth.example.com/application/o/<slug>/`, where `<slug>` is the application's slug.
- To use groups, make sure the token carries a groups claim (in the default profile scope mapping, or one you add) and set `adminGroups` to a group name.

### Authelia

Add a client under `identity_providers.oidc.clients` in Authelia's configuration:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: arclight
        client_name: Arclight
        client_secret: '$pbkdf2-sha512$...'   # hashed secret, not the plain one
        authorization_policy: two_factor
        redirect_uris:
          - https://arclight.example.com/api/v1/auth/oidc/authelia/callback
        scopes: [openid, profile, email, groups]
        token_endpoint_auth_method: client_secret_basic
```

Put the plain secret in Arclight and the hash in Authelia. Issuer in Arclight: `https://auth.example.com`. Add `groups` to the scopes in Arclight too.

### Keycloak

Roughly: in your realm, Clients > Create client, type OpenID Connect.

- Turn Client authentication on and keep Standard flow enabled.
- Valid redirect URI: `https://arclight.example.com/api/v1/auth/oidc/keycloak/callback`.
- Copy the secret from the Credentials tab.
- Issuer in Arclight: `https://auth.example.com/realms/<realm>`.
- For groups, add a "Group Membership" mapper to the client's dedicated scope: claim name `groups`, "Full group path" off, and include it in the ID token and userinfo.

### Pocket ID

Create an OIDC client, set the callback URL to `https://arclight.example.com/api/v1/auth/oidc/pocketid/callback`, and copy the client id and secret. The issuer is your Pocket ID address, for example `https://auth.example.com`. The groups claim is named `groups`. Pocket ID sign-in is passkey-only, so MFA is built in.

### Others

- Zitadel: create a web application with the authorization code flow and PKCE; the issuer is your Zitadel address.
- Google: issuer `https://accounts.google.com`. Google does not send groups, so use `matchBy` and `autoCreate` only, and note the mobile-app limit above.
- Microsoft Entra ID: issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`.

## Forward-auth (trusted header) sign-in

Some setups put a login proxy in front of Arclight (Authelia or an Authentik proxy outpost behind Traefik, Caddy or nginx). The proxy signs people in and passes their name in a request header. Arclight can accept that header and skip its own login. It is **off by default**.

Prefer OpenID Connect when your provider supports it: it does not depend on network layout. Use forward-auth when you already have the proxy and want one sign-in for everything.

### Settings

| Field | Default | What it does |
|---|---|---|
| enabled | off | Turns the feature on. You cannot enable it without `trustedProxies`. |
| trustedProxies | none | The addresses of your proxy: IPs or CIDR ranges, for example `10.0.0.2` or `172.18.0.0/16` (a Docker network). |
| userHeader | `Remote-User` | Header holding the username. |
| emailHeader | `Remote-Email` | Header holding the email. |
| nameHeader | `Remote-Name` | Header holding the display name. |
| groupsHeader | `Remote-Groups` | Header holding groups, separated by commas or `\|`. |
| autoCreate | off | Create an account for someone Arclight does not know yet. |
| defaultRole | `user` | Role of created accounts. |
| adminGroups, allowedGroups | empty | Same rules as for [OpenID Connect](#roles-from-groups). |
| allowAdmins | on | The header may sign in admin accounts (by username, link or an admin group). Off: a header that names an admin, or would make someone admin, is ignored, and admins sign in with their password or OpenID Connect. |

### How Arclight decides to trust a request

Arclight looks only at the address of the TCP connection itself, the machine that actually connected to it. It never reads `X-Forwarded-For` for this. A request that arrives from any other address with these headers is ignored, as if the headers were not there.

That makes two things your job:

- **Your proxy must remove these headers from client requests** and set them only from its own login result. Most forward-auth setups do this when told which headers to copy, but check. If a client's own `Remote-User: admin` ever reaches Arclight through the proxy, that client is the admin. Turning `allowAdmins` off limits such a mistake to user accounts.
- **Arclight's port must not be reachable except through the proxy**, or the trusted range must be just the proxy. If other containers or machines are inside the trusted range, anything there can pretend to be anyone. Use a dedicated Docker network for the proxy and Arclight.

### Which account do you get

In order: an earlier forward-auth link, then an account with the same username, then a unique **non-admin** account with the same verified email, then a new account if `autoCreate` is on. Admins are not matched by email, as with OpenID Connect. Group rules work as described under [Roles from groups](#roles-from-groups).

### Example: Authelia

Let your proxy ask Authelia first and copy its answer headers to Arclight. With Authelia's standard forward-auth endpoint the headers are `Remote-User`, `Remote-Groups`, `Remote-Email` and `Remote-Name`, which match the defaults. In Caddy, roughly:

```
arclight.example.com {
    forward_auth authelia:9091 {
        uri /api/authz/forward-auth
        copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
    }
    reverse_proxy arclight:7878
}
```

With nginx the same idea uses `auth_request` and `auth_request_set` to copy each header into `proxy_set_header`. Set `trustedProxies` to the proxy's address, for example `172.18.0.0/16`.

### Example: Authentik proxy outpost

Authentik's outpost sends different header names. Set them in Arclight:

| Arclight field | Value |
|---|---|
| userHeader | `X-authentik-username` |
| emailHeader | `X-authentik-email` |
| nameHeader | `X-authentik-name` |
| groupsHeader | `X-authentik-groups` (Authentik separates groups with `\|`) |

### Apps and the API

With forward-auth, the API (`/api/v1` and `/api/v3`) is behind the proxy too. The mobile app, the Jellyfin plugin and *arr-compatible tools sign in with an API key and cannot do a browser login at the proxy. Either exclude `/api/` from the forward-auth check at the proxy, or give those apps a separate internal address that skips it. API keys keep working either way: Arclight still requires a valid key on those paths.

## Two-factor for local accounts

Two-factor applies to accounts that sign in with a username and password. Set it up on your Profile page, under Security.

### Confirming it's you

Adding an authenticator app, a passkey or a personal API key gives lasting access, so Arclight checks that it is really you. If you signed in within the last 10 minutes, nothing extra happens. Otherwise Arclight asks for your current password first. A wrong password counts as a failed sign-in and is rate-limited like the login page.

Accounts without an Arclight password (created by a media server or an identity provider) cannot type one: sign out, sign in again, and add it within 10 minutes. Behind [forward-auth](#forward-auth-trusted-header-sign-in), an account without a password is not asked, since the proxy signs in every request. Each new authenticator, passkey and API key is recorded in the audit log (`user.2fa.enable`, `user.passkey.add`, `user.apikey.create`).

API: `POST /user/me/2fa/totp/setup`, `POST /user/me/passkeys/options` and `POST /user/me/apikeys` answer `401 REAUTH_REQUIRED` for an older session; send the password as `currentPassword` in the body to continue. A wrong one answers `401 INVALID_CREDENTIALS`, too many `429 RATE_LIMITED`.

### Authenticator app (TOTP)

1. Choose to add an authenticator app. Scan the QR code with any authenticator app, or type the secret by hand.
2. Enter the 6-digit code the app shows to confirm.
3. Arclight shows **10 one-time recovery codes, once**. Store them somewhere safe.

Codes change every 30 seconds. Arclight accepts one step of clock drift either way, and each code works only once. To get a fresh set of recovery codes, regenerate them with a current code (the old set stops working). Turning TOTP off needs a current code or a recovery code.

Sign-in is then two steps: password, then code. The code prompt expires after 5 minutes or after 5 wrong codes; start again from the password.

### Passkeys

Add a passkey from Profile > Security. A passkey can be used in two ways:

- As the second step after a password.
- On its own: choose "Sign in with a passkey" on the login page and skip the password.

Things to know:

- A passkey belongs to the host name you used when you registered it. One registered at `arclight.example.com` does not work at a LAN IP address or another name. Register it at the address you will use every day.
- Passkeys need HTTPS (or `localhost`).

### Requiring two-factor for admins

Settings > Security has **Require two-factor for admins**. When it is on, an admin who signs in with a password and has no second factor can only set one up until they do. You can turn it on only after your own account has a second factor. Sessions opened by a provider or a passkey are exempt.

### Resetting someone's two-factor

If a user loses their authenticator and recovery codes, an admin opens Settings > Users and resets that user's two-factor. That removes their TOTP, recovery codes and passkeys and signs them out everywhere. They sign in with the password and set it up again.

### HTTP Basic mode

If the login method is "Browser prompt (HTTP Basic)", accounts that have a second factor cannot use it, because the browser prompt has no place for a code. Those accounts use the login page, or an [API key](#per-user-api-keys) for apps.

## Per-user API keys

Besides the single admin API key, every account can make its own named keys on Profile > API keys. Use one per script or app so you can revoke it without touching the rest.

- Keys start with `alu_` and are **shown once** when created. Copy it then.
- Give a key a name and, optionally, an expiry in days.
- The list shows when each key was last used. Revoke any key at any time.
- Admins see and revoke everyone's keys under Settings > Security.

### Scopes

| Scope | What the key can do |
|---|---|
| `read` | Read-only: GET requests only. |
| `requests` | What the account itself may do in the request portal. Never admin actions. |
| `admin` | Full access. Only admin accounts can create one. If the account is later demoted, the key acts as `requests`. |

### Using a key

Send it as a header or in the address:

```
curl -H "X-Api-Key: alu_..." https://arclight.example.com/api/v1/...
curl "https://arclight.example.com/api/v1/...?apikey=alu_..."
```

The header is the better choice: addresses end up in logs.

### Limits

- A key can never manage credentials: creating keys, two-factor, passkeys, linked sign-ins and passwords all need a signed-in browser session.
- Keys without the `admin` scope cannot read settings that hold secrets: security settings, the global API key, identity settings, the config export and backup downloads.
- The install-wide API key (Settings > Security > API keys), the mobile app, the Jellyfin plugin's `alj_` keys and the Sonarr/Radarr-compatible `/api/v3` API all keep working exactly as before.

See the [API reference](../API.md) for the endpoints.

## Related

- [Users and security](users-and-security.md)
- [Hosting under a sub-path](../getting-started/sub-path-hosting.md)
- [Reaching Arclight from outside your home](../getting-started/exposing-outside-home.md)
- [Mobile app](mobile-app.md)
- [Locked out](../TROUBLESHOOTING.md#locked-out)
