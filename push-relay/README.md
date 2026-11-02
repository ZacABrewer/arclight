# Arclight push relay

A small Cloudflare Worker that lets self-hosted Arclight servers send push notifications to the
Arclight iOS and Android apps (Arclight Admin, the companion app, and Arclight, the player app).

Apple (APNs) and Google (FCM) only deliver notifications to an app when the sender holds that app's
signing credentials. Those credentials can't be shipped inside thousands of self-hosted servers, so
the project runs this relay instead:

1. The app gets a push token from Apple or Google and registers it with the relay. The relay
   returns a random `deviceId` and `secret`.
2. The app gives `deviceId` and `secret` to the user's own Arclight server.
3. When the server has something to say, it posts the notification to the relay with that
   `deviceId` and `secret`. The relay forwards it to Apple or Google and forgets it.

The project's instance runs at `https://arclight-push.moviemethat.com`. Anyone can run their own
(see [Run your own relay](#run-your-own-relay)).

## Privacy guarantees

These match the published privacy policy (`site/src/content/docs/legal/privacy.md`). Keep them in
step if either changes.

- **Notification content is never stored or logged.** Title, body, data and thread ID pass
  through memory to Apple or Google and nothing else. The tests check D1 and every console line
  for them on success and on every error path.
- **What is stored, per registration** (`migrations/`): the push token, the random
  `deviceId`, the platform, a SHA-256 hash of the secret (never the secret), the app version and
  app ID (which Arclight app registered) if the app sends them, the APNs environment, created and last-used timestamps, and the per-device
  rate-limit counter. No names, accounts, IP addresses or server addresses.
- **Deletion**: when the app unregisters (`DELETE /v1/devices/:id`); when Apple or Google report the
  token invalid (the send returns `410`); and by a daily cron after 90 days without use (no send and
  no token update).
- **Logs**: Workers invocation logs (which would record request URLs and headers) and traces are
  turned off in `wrangler.jsonc`. The Worker's own log lines contain only status codes and provider
  error codes, never tokens, device IDs, secrets or content.
- **IP addresses** are used only as keys for Cloudflare's rate-limiting binding. The counters live
  in Cloudflare's rate-limiting service for about a minute and are never written to the database.

To delete a record on request (the "Delete your data" page promises this), find it by token or
device ID:

```sh
npx wrangler d1 execute arclight-push --remote --command "DELETE FROM devices WHERE token = '<push token>'"
npx wrangler d1 execute arclight-push --remote --command "DELETE FROM devices WHERE device_id = '<device id>'"
```

## API

All bodies are JSON. Errors are `{ "error": "..." }`. Responses are never cached.

### `POST /v1/devices` (app)

```json
{ "token": "<APNs or FCM token>", "platform": "ios", "appId": "com.moviemethat.arclight.admin", "appVersion": "1.4.0", "environment": "sandbox" }
```

- `platform`: `ios` or `android`.
- `appId` (optional): the app's bundle ID / application ID, reverse-DNS, up to 155 characters. On
  iOS it is the APNs topic for the device and must be in `APNS_TOPICS` (else `400 appId not
  allowed`). Registrations without one (older app builds) use the first topic in the list. On
  Android it is only stored; FCM delivery does not depend on it.
- `appVersion` (optional): up to 64 printable ASCII characters.
- `environment` (optional, iOS only): `production` (default) or `sandbox`, for development builds
  whose tokens only work against the APNs sandbox. Ignored for Android.

Returns `201 { "deviceId": "<22 chars>", "secret": "<43 chars>" }`: 128-bit and 256-bit random
values, base64url. The secret is shown once; only its hash is kept.
Limited to 10 registrations a minute per IP (`429` with `Retry-After`).

### `PUT /v1/devices/:deviceId` (app)

`Authorization: Bearer <secret>`, body `{ "token": "<new token>" }`. Replaces the token after the OS
rotates it. `204`. Wrong secret or unknown device: `404`. No secret: `401`.

### `DELETE /v1/devices/:deviceId` (app)

`Authorization: Bearer <secret>`. Deletes the registration. `204`, also when it is already gone.
Wrong secret for an existing device: `404`.

### `POST /v1/send` (Arclight server)

`Authorization: Bearer <secret>`:

```json
{
  "deviceId": "<deviceId>",
  "title": "Download finished",
  "body": "Dune (2021) is ready to watch",
  "data": { "route": "/requests/42", "channel": "downloads" },
  "badge": 3,
  "threadId": "request-42",
  "appId": "com.moviemethat.arclight.admin"
}
```

| Field | Rules |
|---|---|
| `title` | string, up to 200 characters |
| `body` | string, up to 1000 characters (title and body can't both be empty) |
| `data` | optional object of string values, up to 2048 bytes as JSON. Keys `aps`, `from`, `notification`, `message_type`, `collapse_key`, `google.*` and `gcm.*` are reserved. On Android, `data.channel` picks the notification channel (default `default`). |
| `badge` | optional integer 0 to 99999 |
| `threadId` | optional, 1 to 64 characters of `A-Z a-z 0-9 _ . : -`. Groups (iOS `thread-id`) and replaces (iOS `apns-collapse-id`, Android `tag`) earlier notifications with the same ID. |
| `appId` | optional, the app ID the Arclight server has on record for the device. iOS only: used as the APNs topic when the device registered without an `appId` (an `appId` stored at registration always wins). Must be in `APNS_TOPICS`. Ignored for Android. |

The encoded provider payload must also fit Apple's and Google's 4 KB limit (multi-byte text counts
more than once), otherwise `413`.

| Status | Meaning |
|---|---|
| `200 { "ok": true }` | Accepted by Apple or Google. |
| `400` | Invalid body, or `{ "error": "appId not allowed" }` for an iOS app ID outside `APNS_TOPICS`. |
| `401` | Missing or malformed `Authorization` header. |
| `404` | Unknown device or wrong secret (deliberately indistinguishable). |
| `410` | Apple or Google say the token is dead. The relay has deleted the device; stop sending to it. |
| `413` | Payload too large for the provider. |
| `429` | Rate limited, see `Retry-After` (seconds). Per device: bursts of 10, then 1 a minute (60 an hour). Per server IP: 600 a minute. |
| `502` | Apple or Google failed or were unreachable: `{ "error": "provider error", "reason": "<provider code>" }`. May carry the provider's `Retry-After`. |
| `503 { "error": "not configured" }` | The relay has no credentials for that platform. |

### `GET /v1/health`

`{ "ok": true, "apns": true, "fcm": true }`: whether each provider's credentials are set.

### CORS

The device endpoints and health answer CORS for the app origins `capacitor://localhost`,
`https://localhost` and `http://localhost` only. `/v1/send` is server to server and has no CORS.
Unknown paths return `404`, wrong methods `405`, both as JSON.

## APNs and HTTP/2

APNs accepts **HTTP/2 only**. The Workers runtime (workerd) has no HTTP/2 client of its own. In
production, a Worker's outbound `fetch()` goes through Cloudflare's proxy stack, which negotiates
HTTP/2 with the origin, so sending to `api.push.apple.com` works from a deployed Worker. A
Cloudflare runtime engineer confirms this in
[cloudflare/workerd#4841](https://github.com/cloudflare/workerd/issues/4841), and other relays
run this way in production. Two caveats:

- It is **observed behaviour, not documented or guaranteed** by Cloudflare.
- It **does not work under local `wrangler dev`** (APNs drops the HTTP/1.1 connection: `Network
  connection lost`). Test APNs against a deployed Worker or with `wrangler dev --remote`. FCM works
  locally. The automated tests mock both providers.

After the first deploy, register a development build (`environment: "sandbox"`) and send it a
notification to confirm the path. If Cloudflare ever stops upgrading to HTTP/2, the relay returns
`502 provider unreachable` for iOS sends. The fallback is an HTTP/2 forwarder (for example a tiny
nginx or Go proxy in a Cloudflare Container or on any VM) that accepts the same request and passes
it to Apple unchanged. Point the relay at it with the `APNS_PRODUCTION_ORIGIN` and
`APNS_SANDBOX_ORIGIN` vars; the JWT and headers are passed through as they are, and the forwarder
never needs the key.

## Deploy

One-time setup (needs a Cloudflare login with Workers, D1 and the `moviemethat.com` zone):

```sh
cd push-relay
pnpm install

# 1. Create the database and paste the printed database_id into wrangler.jsonc (d1_databases).
npx wrangler d1 create arclight-push

# 2. Create the table.
npx wrangler d1 migrations apply arclight-push --remote

# 3. Set the provider secrets (each command prompts for the value).
npx wrangler secret put APNS_KEY_P8       # paste the whole AuthKey_XXXXXXXXXX.p8 file, PEM lines included
npx wrangler secret put APNS_KEY_ID       # the 10-character key ID
npx wrangler secret put APNS_TEAM_ID      # the 10-character Apple team ID
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON   # the whole service-account JSON file
# (or pipe a file: npx wrangler secret put APNS_KEY_P8 < AuthKey_XXXXXXXXXX.p8)

# 4. Deploy. The route in wrangler.jsonc attaches arclight-push.moviemethat.com as a Workers
#    custom domain (Cloudflare creates the DNS record and certificate).
npx wrangler deploy

curl https://arclight-push.moviemethat.com/v1/health
```

`wrangler secret put` before the first deploy creates the Worker with only the secret; that is fine.
A relay with only one provider configured works and answers `503 not configured` for the other.

Credentials:

- **APNs**: Apple Developer, Certificates, Identifiers & Profiles, Keys: create a key with *Apple
  Push Notifications service (APNs)* enabled, download the `.p8` (once). One key works for both the
  sandbox and production environments and every app in the team. The topic is the bundle ID. The
  relay serves several apps, so the topics are an allow-list in the `APNS_TOPICS` var,
  comma-separated, default first: `com.moviemethat.arclight.admin` (Arclight Admin, the companion
  app) and `com.moviemethat.arclight` (Arclight, the player app). Each device's topic comes from the
  `appId` it registered with; devices registered without one use the first entry. When
  `APNS_TOPICS` is unset, the older single `APNS_TOPIC` var is used, and without either the relay
  falls back to those two built-in IDs.
- **FCM**: Firebase console, Project settings, Service accounts: generate a new private key. The
  account needs the *Firebase Cloud Messaging API Admin* role (the default Firebase Admin SDK
  account has it), and the *Firebase Cloud Messaging API (V1)* must be enabled for the project.

After the one-time setup, `.github/workflows/push-relay.yml` applies new migrations and deploys on
every push to `main` that touches `push-relay/`. Its `CLOUDFLARE_API_TOKEN` needs *Workers Scripts:
Edit*, *D1: Edit* and, for the custom domain, *Workers Routes: Edit* and *DNS: Edit* on the
`moviemethat.com` zone.

## Rotating keys

- **APNs**: create a new key in the Apple Developer portal, then
  `wrangler secret put APNS_KEY_P8` and `wrangler secret put APNS_KEY_ID`. Each secret change
  rolls out a new Worker version; isolates pick up the new key on their next request (the cached
  provider token is keyed by team and key ID). Revoke the old key in the portal afterwards.
- **FCM**: create a new key for the service account, `wrangler secret put
  FCM_SERVICE_ACCOUNT_JSON`, then delete the old key in Google Cloud IAM.
- **Device secrets** can't be rotated by the relay; the app unregisters and registers again.

## Run your own relay

The relay is part of the GPL-3.0 Arclight source. To run your own, deploy this directory to your
own Cloudflare account with your own domain (edit `routes` and `APNS_TOPICS` in `wrangler.jsonc`)
and your own APNs/FCM credentials. Your credentials must belong to the app builds that receive the
notifications, so in practice this means building the Arclight apps yourself with your own bundle
IDs and listing them in `APNS_TOPICS`. Then point your
Arclight server at it:

```sh
ARCLIGHT_PUSH_RELAY_URL=https://push.example.com
```

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test        # Vitest inside the Workers runtime (@cloudflare/vitest-plugin), providers mocked
pnpm dev         # local wrangler dev (APNs needs --remote, see above)
```

Code map: `src/index.ts` (routing, devices, send, cron), `src/apns.ts`, `src/fcm.ts`,
`src/validate.ts`, `src/http.ts`, `src/crypto.ts`.
