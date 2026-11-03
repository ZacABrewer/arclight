# Security: Authentication, API Keys, Roles and Safe Downloads

This file covers who can reach Arclight and what they can do: anonymous access, the API key, user roles, the local-network bypass, Basic auth, sign-in rate limiting, session cookies, the compatibility API, the calendar feed, masked secrets and file download safety.
Prerequisites: setup finished, one admin account, and a second account with the "user" role (create it under Settings -> Users). Many checks use `curl` (built into Windows 10/11 as `curl.exe`; in PowerShell type `curl.exe`, not `curl`). Replace `BASE` with your address and `KEY` with the API key from Settings -> Security.
Test environment: Native (`BASE` = `http://localhost:17878`) unless noted. Docker and NAS use `http://<host>:7878`. Checks about the local-network bypass are most meaningful from a second computer on the LAN; from the same machine you are always "local".

## Anonymous access and API key

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-01 | Set Settings -> Security authentication to a method that requires login (Forms) and turn off the local bypass. In a terminal run `curl -i BASE/api/v1/series` without any key. | HTTP 401 with JSON `{"error":"authentication required","code":"UNAUTHORIZED"}`. No series data is returned. | |
| SEC-02 | Run `curl -i -H "X-Api-Key: KEY" BASE/api/v1/series`. | HTTP 200 and a JSON list (possibly `[]`). | |
| SEC-03 | Run `curl -i "BASE/api/v1/series?apikey=KEY"`. | HTTP 200 and the same list as SEC-02. | |
| SEC-04 | Run `curl -i -H "X-Api-Key: wrong-key" BASE/api/v1/series`. | HTTP 401, same JSON as SEC-01. | |
| SEC-05 | Run `curl -i BASE/api/v1/system/ping` and `curl -i BASE/api/v1/auth/status` with no key. | Both answer without a key (HTTP 200); these public probes reveal no library data. | |
| SEC-06 | Open `BASE/api/v1/system/status` in a private browser window that is not signed in. | The page shows the 401 JSON, not system details. Opening `BASE/` shows the sign-in page. | |
| SEC-07 | Regenerate the key: in Settings -> Security click the regenerate button for the API key and confirm (or via API: `curl -X POST -H "X-Api-Key: KEY" BASE/api/v1/settings/security/apikey`). Note the new key. | A new, different key is shown. | |
| SEC-08 | Repeat SEC-02 with the OLD key, then with the NEW key. | Old key: HTTP 401. New key: HTTP 200. Any external tool configured with the old key now fails until updated. | |
| SEC-40 | In Settings -> Security look at the API key box, then click Show. Open Settings -> Audit log. | The box shows `********` and the last four characters until Show; Show displays the full key. The audit log has an `apikey.reveal` entry for you. `curl -i -H "X-Api-Key: KEY" BASE/api/v1/settings/security` shows the masked key. | |
| SEC-41 | Sign in, wait more than 10 minutes, then on Profile -> Security click Create API key (or Add passkey, or Set up authenticator app). Enter a wrong password, then the right one. | A "Confirm your password" dialog opens; the wrong password says it is not right and you stay signed in; the right one continues and the key (or passkey, or QR code) appears. Right after signing in, no password is asked. | |

## Roles

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-09 | Sign in as the plain "user" account. Look at the sidebar. | Settings pages for admin-only areas (Security, Users and similar) are hidden or not usable; library, calendar, activity and wanted pages are visible. | |
| SEC-10 | As the user account, type the address of an admin page directly, for example `BASE/settings/security` and `BASE/settings/users`. | You are redirected away (for example to the Dashboard) and no admin form is shown. | |
| SEC-11 | As the user account, copy the `al_session` cookie value from browser developer tools (Application -> Cookies) and run `curl -i -X PUT -H "Cookie: al_session=<value>" -H "Content-Type: application/json" -d "{\"method\":\"none\",\"requireForLocal\":false,\"sessionDays\":30}" BASE/api/v1/settings/security`. | HTTP 403 `{"error":"admin only","code":"FORBIDDEN"}`. The authentication method is unchanged. | |
| SEC-12 | As the user account, run `curl -i -H "Cookie: al_session=<value>" BASE/api/v1/settings/security`. | The admin-only security settings (including the API key) are NOT returned to a plain user (an error response, not the key). | |
| SEC-13 | As the user account, change your own display name or profile under the user menu -> Profile. | Allowed: this is a self-service action and saves. | |
| SEC-14 | As admin, open Settings -> Users and try to demote the only admin to the user role, then try to delete the only admin. | Both are refused with a message that the last admin cannot be changed (API code `LAST_ADMIN`, HTTP 409). Deleting your own signed-in account is also refused. | |
| SEC-15 | As admin, create a second admin, then demote the first admin. | Allowed now that another admin exists. Promote them back afterwards. | |

## Local-network bypass and Basic auth

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-16 | Set authentication method to "none" (Settings -> Security), Save, then from another computer on the LAN open `http://<host>:7878/`. | Arclight opens without sign-in because every address involved is on the local network (loopback, 10.x, 172.16-31.x, 192.168.x, link-local). | |
| SEC-17 | Set the method back to Forms and turn on the option to not require sign-in for local addresses ("requireForLocal" off). Open the app from the LAN while signed out. | No sign-in is requested from local addresses. A request that arrives through a reverse proxy with a public address in `X-Forwarded-For` still gets 401 (all addresses must be local). | |
| SEC-18 | Turn "requireForLocal" on again (sign-in required for everybody) and reload the app from the LAN in a private window. | The sign-in page appears even from the local network. | |
| SEC-19 | Set the method to Basic. Run `curl -i BASE/api/v1/series` with no credentials, then `curl -i -u admin:<password> BASE/api/v1/series`. | First: HTTP 401 with a `www-authenticate: Basic` header (a browser opens its own username/password prompt). Second: HTTP 200. | |
| SEC-20 | With Basic still selected run `curl -i -u admin:wrong BASE/api/v1/series` once. | HTTP 401. The API key header still works as in SEC-02. Switch the method back to Forms afterwards. | |

## Sign-in protections and sessions

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-21 | Make 10 wrong sign-in attempts in a row: run `curl -i -X POST -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"nope\",\"rememberMe\":false}" BASE/api/v1/auth/login` ten times. Then run it an eleventh time and also try the correct password. | Attempts 1-10 return HTTP 401. From the eleventh attempt onward the answer is HTTP 429 (too many attempts) with a `Retry-After` header (seconds), even for the correct password. Signing in to a different account from the same address does not clear it. | |
| SEC-22 | Wait 15 minutes (or restart Arclight) and sign in with the correct password. | Sign-in works again. | |
| SEC-22b | Right after SEC-21, from a second machine (another address) sign in to the same account with the correct password; wait the `Retry-After` seconds if it answers 429 and try again. Then sign in to a different account. | The same account waits at most 5 minutes (30 seconds after the tenth failure, doubling), then signs in with the correct password. The other account signs in at once. | |
| SEC-23 | Sign in through the web page, open browser developer tools -> Application -> Cookies and inspect `al_session`. | Cookie exists with HttpOnly checked, SameSite "Lax", Path `/`. Without "Remember me" it is a session cookie (expires when the browser closes); with "Remember me" it has an expiry date. Secure is set only when you use `https://`. | |
| SEC-24 | In the page console type `document.cookie`. | The `al_session` cookie is NOT listed (HttpOnly hides it from scripts). | |
| SEC-25 | Click the user menu -> Sign out, then press the browser Back button. | You land on the sign-in page; Back does not show protected data and reloading stays on sign-in. The old cookie value no longer works: `curl -i -H "Cookie: al_session=<oldvalue>" BASE/api/v1/series` returns 401. | |
| SEC-26 | Sign in as the same user in two browsers (A and B). In browser A (via API, there is no screen for this) run `curl -i -X PUT -H "Cookie: al_session=<A cookie>" -H "Content-Type: application/json" -d "{\"currentPassword\":\"<old>\",\"newPassword\":\"<new-long-password>\"}" BASE/api/v1/user/me/password`, then reload both browsers. | The request succeeds. Browser A stays signed in; browser B is sent to the sign-in page (other sessions are ended). The old password no longer works. | |
| SEC-27 | As admin, reset the password of another user who is signed in elsewhere (Settings -> Users). | That user's sessions all end: their browser returns to the sign-in page on the next click. | |
| SEC-27b | Run a fresh install with `ARCLIGHT_TRUSTED_PROXIES` unset, behind your reverse proxy. Sign in, then open Settings -> Security -> Sessions. From a computer outside your network run SEC-21 eleven times, each with a different `-H "X-Forwarded-For: 198.51.100.N"` straight to Arclight's port (not through the proxy). | Sessions show your real address (the proxy's forwarded one). The direct requests get HTTP 429 on the eleventh attempt: a made-up `X-Forwarded-For` from an untrusted address is ignored. | |
| SEC-27c | Set `ARCLIGHT_TRUSTED_PROXIES=none`, restart, sign in through the proxy and look at Sessions. Remove it again afterwards. Also start once with `ARCLIGHT_TRUSTED_PROXIES=10.0.0.2, nonsense`. | With `none` the session shows the proxy's address. With the bad entry Arclight starts and the log has a warning naming `nonsense`. | |
| SEC-27d | Run the headless setup on an empty install twice at the same moment: `curl -X POST -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"<long-password>\"}" BASE/api/v1/setup/complete & curl ... (same)`. Then try once with a root folder that is not an absolute path. | Exactly one admin exists (Settings -> Users). The second call answers 409 or signs in as that admin. A relative root folder answers 400 and creates nothing. | |

## Compatibility API, calendar feed and secrets

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-28 | With sign-in required, run `curl -i BASE/api/v3/series` (no key), then `curl -i -H "X-Api-Key: KEY" BASE/api/v3/system/status`. | First: HTTP 401. Second: HTTP 200 JSON in the Sonarr-compatible shape. The compat probes `BASE/api`, `BASE/ping` and `BASE/initialize.json` answer without a key and expose no library data. | |
| SEC-29 | Disable the compatibility layer: `curl -X PUT -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"enabled\":false}" BASE/api/v1/settings/compat`, then repeat the call with the key from SEC-28. Re-enable with `{"enabled":true}` afterwards. | While disabled `/api/v3/...` answers HTTP 404. After re-enabling it works again. | |
| SEC-30 | Get the calendar feed address: `curl -H "X-Api-Key: KEY" BASE/api/v1/calendar/feed` (returns `{"token":"...","path":"..."}`). Then fetch `curl -i "BASE/api/v1/calendar/feed.ics?token=<token>"` and the same with `token=bad` and with no token. | Valid token: HTTP 200, `text/calendar` content starting with `BEGIN:VCALENDAR`, with no API key needed. Wrong or missing token: HTTP 401. | |
| SEC-31 | Open Settings -> General (TMDB key) and Settings -> Download Clients -> edit a client. | Secret fields show as masked (for example `********`), never the real key or password. | |
| SEC-32 | Run `curl -H "X-Api-Key: KEY" BASE/api/v1/settings/metadata` and `curl -H "X-Api-Key: KEY" BASE/api/v1/downloadclient`. | JSON secret values (`tmdbApiKey`, client `password`) are `"********"`, not the real value. Saving a form with the masked value untouched keeps the stored secret (the TMDB search keeps working). | |
| SEC-32b | Add a Torznab indexer with an API key and a definition indexer with a password or cookie, then run `curl -H "X-Api-Key: KEY" BASE/api/v1/indexer`. Edit each indexer, change only the priority, save, and press Test. | `apiKey` and the definition's password/cookie fields are `"********"`. After saving, the indexers still work and Test passes with the stored secrets. | |

## Safe file downloads

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-33 | Run `curl -i -H "X-Api-Key: KEY" "BASE/api/v1/log/file/arclight.log"`. | HTTP 200 with log text. | |
| SEC-34 | Run `curl -i --path-as-is -H "X-Api-Key: KEY" "BASE/api/v1/log/file/..%2F..%2Fconfig.xml"` and `curl -i -H "X-Api-Key: KEY" "BASE/api/v1/log/file/arclight.db"`. | HTTP 404 both times. Only `arclight.log` and `arclight.log.<number>` can be fetched; no other file is exposed. | |
| SEC-35 | Run `curl -i --path-as-is -H "X-Api-Key: KEY" "BASE/api/v1/system/backup/..%2Farclight.db/download"` and `curl -i -H "X-Api-Key: KEY" "BASE/api/v1/system/backup/notabackup.zip/download"`. | HTTP 404 both times; only names in the exact form `arclight_<type>_<date>.zip` that exist as backups can be downloaded. | |
| SEC-36 | Run the SEC-33 and SEC-35 download URLs without a key while sign-in is required. | HTTP 401: downloads need authentication too. | |

## Browsers, headers and narrow credentials (0.24)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SEC-42 | Run `curl -i -H "Origin: https://evil.example.com" BASE/api/v1/system/status` and the same with `-X OPTIONS -H "Access-Control-Request-Method: PUT"`. Repeat with `-H "Origin: BASE"` (your own address). | The evil origin gets no `Access-Control-Allow-Origin` header. Your own origin gets it with `Access-Control-Allow-Credentials: true`. Every answer has `Vary: Origin`. | |
| SEC-43 | Set `ARCLIGHT_CORS_ORIGINS=https://dash.example.com`, restart, repeat SEC-42 with that origin. Then use `-H "Origin: capacitor://localhost"`. | `https://dash.example.com` gets credentials. `capacitor://localhost` gets `Access-Control-Allow-Origin` without `Access-Control-Allow-Credentials`; the Arclight apps still sign in and play. | |
| SEC-44 | Run `curl -I BASE/` and `curl -I -H "X-Api-Key: KEY" BASE/api/v1/system/status`. Then open `BASE` inside an `<iframe>` on a page served from another address. | Both have `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` and a `Content-Security-Policy` with `frame-ancestors 'self'`. The iframe stays blank. The web app works normally (no console CSP errors). | |
| SEC-45 | With an https Application URL set (Settings -> Requests), run `curl -I https://<that host>/` and `curl -I http://<LAN address>:7979/`. | The https host answers `Strict-Transport-Security: max-age=15552000`; the LAN address does not. Signing in on the https host gives an `al_session` cookie with Secure set. | |
| SEC-46 | In the browser console of a page on another address run `new WebSocket("ws://<arclight>/api/v1/events")`. Then, signed in to Arclight in a tab, open Settings -> Security -> Sessions in another browser and end every session. | The foreign page's socket fails (HTTP 403). The signed-in tab's live updates stop within about 30 seconds and it returns to sign-in on the next click. | |
| SEC-47 | Pair Arclight Admin (or use an app token), then `curl -i -X POST -H "Authorization: Bearer <app token>" -H "Content-Type: application/json" -d "{}" BASE/api/v1/config/import`. Repeat with a personal API key of scope Requests, and against `PUT BASE/api/v1/settings/vpn`. Then `GET BASE/api/v1/settings/vpn` with the app token. | The writes answer HTTP 403. The GET answers 200. The main API key (or an Admin-scope key) can still import. | |
| SEC-48 | With a personal API key of scope Requests, try to create a notification of type Custom script (`POST BASE/api/v1/notification` with `"implementation":"custom-script"`). | HTTP 403. The same with an admin session works. | |
| SEC-49 | Run `curl "BASE/api/v1/system/status?apikey=KEY"` and fetch the calendar feed with its `token=`. Then open System -> Logs and the log file (SEC-33). | The log lines show `apikey=********` and `token=********`; the real key and token appear nowhere in the logs, nor any `Authorization` or `Cookie` value. | |
| SEC-50 | Turn on the public request portal with a portal-only hostname (Settings -> Requests). Sign in as admin on that hostname and open `https://<portal host>/api/v1/settings/security`. Repeat with `-H "X-Api-Key: KEY"`. | The admin session answers HTTP 403 (`PORTAL_ONLY_HOST`); the portal itself works. The API key gets 200. The main address works as before. | |
| SEC-51 | Pair a device in Arclight Admin, then leave it unused for 90 days (or set the device's last-used date back in a test database). | The device's next request answers 401, it disappears from the paired devices list, and the audit log has `app.device.expired`. | |
