# Arclight Admin for iOS and Android

Arclight Admin, the Arclight companion app: a native shell (Capacitor 8) around the web UI of your own Arclight server, like the Home Assistant and Jellyfin apps. The app adds the native parts: server setup and switching, QR pairing, push notifications through the Arclight push relay, an optional Face ID / Touch ID / fingerprint lock, the Android share sheet and its own settings, about and licenses screens. Everything else is the server's own interface, so admins get the admin portal and other people the request portal, and new server features show up without an app update.

Arclight Admin is not the player app. **Arclight** (`com.moviemethat.arclight`, in `apps/player`) is a separate app for playing your library, with its own store listings and its own checklists: [Android and Google TV](../../docs/mobile/RELEASE-PLAYER-ANDROID.md), [iOS](../../docs/mobile/RELEASE-PLAYER-IOS.md).

Store checklists for Arclight Admin: [docs/mobile/RELEASE-IOS.md](../../docs/mobile/RELEASE-IOS.md), [docs/mobile/RELEASE-ANDROID.md](../../docs/mobile/RELEASE-ANDROID.md).

## How it works

```
 app's own screens (this package, bundled)         the user's server (its own web UI)
 capacitor://localhost  /  https://localhost  ───►  http://192.168.1.20:7878/  (same WebView)
   server list · add server · settings                window.Capacitor.Plugins.ArclightShell
   unreachable · licenses · lock                       (dist/arclight-shell.js, injected)
```

- **Adding a server** (`src/core/address.ts`, `src/core/probe.ts`). What the user types is turned into candidate URLs and all are probed in parallel with `GET /api/v1/system/ping` and `GET /api/v1/auth/status` (both public). The first candidate, in order, that answers like Arclight wins:
  - a typed `https://` is kept; a typed `http://` is kept for private/LAN hosts, and for a public host `https://` is tried first; without a port, `:7878` is tried after the default port;
  - without a scheme, `https://` comes first; `http://` is added only for private/LAN hosts (RFC 1918, loopback, link-local, CGNAT/Tailscale, `.local`, `.lan`, `.home.arpa`, `.ts.net`, single-label names) and bare IPs;
  - a reverse-proxy path (`example.com/arclight`) is kept;
  - redirects are followed and the final base URL is saved.
  Errors say which case it is: not reachable, timed out, TLS certificate not trusted, or "something answered but it is not Arclight".
- **Plain http** (`src/core/transport.ts`). `https://` and loopback are always fine. A plain-`http://` server on a private network shows a one-time notice ("not encrypted") per origin. A plain-`http://` server on a public host needs the host name typed to confirm. Once a host has worked over `https://` it is pinned: a later `http://` address for it needs the typed confirmation too. Saved servers are checked again on every connect (existing servers see the notice or confirmation once after updating); a saved public `http://` server that now answers over `https://` is moved there. Only origins that passed this are handed to the native layer, so the others never load in the WebView and never get the native bridge. Android and iOS allow cleartext at the platform level (the addresses are not known at build time); this check is what enforces the policy.
- **Pairing QR / link**: `arclight-admin://pair?url=<encoded server URL>` (`src/core/qr.ts`). Scanned in the app or opened from the camera app (the `arclight-admin://` scheme is registered on both platforms). The older `arclight://pair?url=...` codes shown by servers before this rename are still read when scanned inside the app; the `arclight://` scheme itself belongs to the player app.
- **Servers** are stored with Capacitor Preferences (addresses and names only). Sign-in lives in the WebView's cookies, set by the server. Push relay credentials live in the native secure store (iOS Keychain, device-only, after first unlock; Android Keystore-encrypted), scoped per server origin.
- **Server pages** load in the app's WebView. Capacitor normally allows only hosts listed at build time; `ArclightNativePlugin` (Swift and Java, in the native projects) allows the saved servers' origins, which the app's own screens hand over after every change. Other sites open in the system browser.
- **Bridge gate.** A server page runs the server's web UI and `arclight-shell.js` in one JavaScript context, so the native bridge treats it as untrusted. The plugin puts a gate in front of Capacitor's bridge (Android: the `androidBridge` message listener; iOS: the `bridge` script message handler). The app's own origin gets the full bridge. A saved server's page, main frame only, gets just what the shell needs (`BridgePolicy.java`, `BridgeGate` in the Swift file; keep the two in step): `ArclightNative.getInfo/shellState/secureGet/secureSet/secureRemove`, `App.getInfo/getLaunchUrl` and its `appUrlOpen`/`appStateChange` listeners, `PushNotifications` permissions, `register` and the `registration`/`registrationError`/`pushNotificationActionPerformed` listeners, `Device.getInfo`, `Browser.open` for http(s) links, `NativeBiometric.isAvailable/verifyIdentity`, the share-target listener, and `CapacitorHttp.request` only for `POST/PUT/DELETE` to the push relay's `/v1/devices` endpoints. Everything else (Preferences, `setServerOrigins`, cookies, the scanner, Cordova plugins, other origins, iframes) is refused. Secure-store calls from a server page are always scoped to that page's own origin. What the shell knows about the app comes from a per-origin snapshot (`shellState`: the servers at that origin and the app settings). With Android's legacy `addJavascriptInterface` bridge (very old WebViews) a gate is not possible, so servers then open in the system browser.
- **`ArclightShell`** (`src/shell/`) is built into `dist/arclight-shell.js` and injected at document start into server pages. It defines `window.Capacitor.Plugins.ArclightShell` before the server's web UI runs and fires `arclightshellready` on `window`. Contract (`src/shell/contract.ts`):

  | Method | Result |
  |---|---|
  | `info()` | `{ platform: 'ios' \| 'android', appVersion, build, pushAvailable }` |
  | `registerPush()` | `{ relayDeviceId, relaySecret, platform, deviceName, appId }` (`appId` is this app's bundle ID; the server stores it and the push relay uses it as the APNs topic); rejects with `{ code: 'denied' \| 'unavailable' \| 'relay', message }` |
  | `unregisterPush()` | `void` |
  | `switchServer()` | back to the server list |
  | `openExternal({ url })` | opens http(s)/mailto/tel in the system browser |

  Each saved server (origin) gets its own relay device and secret, so a server can only send to, re-point or delete its own registration. `unregisterPush()` deletes that server's device; removing the server from the app or "Remove push registration" in Settings does the same. Token rotation sends `PUT /v1/devices/<id>` for every registration. Installs from before 0.24 had one device shared by every server: it is moved into the secure store on the first start, keeps working for the servers that had it, is replaced by a device of its own when a server turns notifications on again, and is deleted at the relay once no saved server uses it.
- **Notification taps**: payload `data.url` (a path such as `/requests/12`) is opened on the saved server whose base URL is `data.server`, switching servers if needed (from a server page, a tap for another server goes through the app's own screens, `#/open`). Unknown servers and non-path URLs are ignored. A server page in the foreground sees taps on other servers' notifications (the tap listener is shared); it does not see notifications that arrive while it is open.
- **User agent**: ` ArclightApp/<version> (ios|android)` is appended, so the web UI can detect the app.
- **Unreachable server**: the app probes before opening a server; a page that fails to load later (`server.errorPath`) also lands on the native "Can't reach server" screen (retry, switch server, edit address).
- **Startup intro** (`src/intro/`): on a cold start the 6.1 s Arclight intro plays before the server list or the last server opens. It is the animation from `design/brand/intro/src` drawn live in the app's DOM (scaled to fit, letterboxed on black), not the MP4. The native splash is the mark on black and is hidden once the intro's first (black) frame is on screen. Tap anywhere, or the Android back gesture, skips it. It never plays when the app was launched by a notification tap, a share or a deep link (one arriving during the intro ends it at once), when returning from a server page, or with "Play intro on launch" off; with reduced motion the static logo shows for 1 s instead. The sound (`arclight-sting.m4a`, "Intro sound" setting) uses Web Audio, which WebKit plays in the ambient audio category, so it follows the iPhone silent switch and does not stop other audio; on Android it plays at media volume.
- **Share sheet (Android)**: "Request in Arclight" on shared text or IMDb/TMDB links opens `/discover/search?q=<title>` on the current or selected server.

## Develop

```sh
pnpm install                                 # from the repository root
pnpm --filter @arclight/mobile dev           # app screens in a desktop browser (no native features)
pnpm --filter @arclight/mobile test          # unit tests (address normalisation, probe, QR, store, push, contract, intro)
pnpm --filter @arclight/mobile typecheck
pnpm --filter @arclight/mobile sync          # build + cap sync (both platforms)
```

Open the native projects with `npx cap open android` (Android Studio, JDK 21) or `npx cap open ios` (Xcode 26 on a Mac). Generated resources are committed; re-generate them after a change:

- `pnpm --filter @arclight/mobile assets`: icons, adaptive/monochrome icons, notification icon and splash images from `design/brand`;
- `pnpm --filter @arclight/mobile licenses`: `src/generated/licenses.json` for the Licenses screen.

Build-time setting: `VITE_PUSH_RELAY_URL` (default `https://arclight-push.moviemethat.com`) for forks running their own relay.

Identity: app name Arclight Admin, bundle ID / application ID `com.moviemethat.arclight.admin` (also `APP_ID` in `src/config.ts`; keep it equal to `appId` in `capacitor.config.ts`), URL scheme `arclight-admin`, version 1.0.0 (build 1; CI uses the run number for store uploads), iOS 16+, Android 8.0+ (minSdk 26, targetSdk 36).

## CI (`.github/workflows/mobile.yml`)

Runs on pushes and pull requests that touch `apps/mobile/**`, `design/brand/**` or the workflow, and on manual dispatch.

| Job | Always | With secrets |
|---|---|---|
| Android (ubuntu, JDK 21) | typecheck, tests, `assembleDebug` → APK artifact | keystore secrets → signed `bundleRelease` AAB artifact; plus `PLAY_SERVICE_ACCOUNT_JSON` and a manual run with **upload** → Play **internal** track |
| iOS (macos-latest, latest Xcode) | unsigned simulator build | App Store Connect API key + team ID and a manual run with **upload** → archive with cloud-managed signing, upload to TestFlight |

Push works on Android only when `GOOGLE_SERVICES_JSON` is set; without it the build still succeeds and `info().pushAvailable` is `false`.

### GitHub secrets

Set them with the GitHub CLI from the repository root (`gh secret set NAME < file` or `gh secret set NAME --body "value"`). Never commit any of these.

| Secret | What it is | Where to get it | Command |
|---|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | Upload keystore (base64). Play App Signing holds the real signing key; this only signs uploads. | Create once: `keytool -genkeypair -v -keystore upload.keystore -alias upload -keyalg RSA -keysize 4096 -validity 10000`. Back it up outside the repo. | `base64 -w0 upload.keystore \| gh secret set ANDROID_KEYSTORE_BASE64` (macOS: `base64 -i upload.keystore \| gh secret set ...`) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | chosen in `keytool` | `gh secret set ANDROID_KEYSTORE_PASSWORD` |
| `ANDROID_KEY_ALIAS` | Key alias (`upload` above) | chosen in `keytool` | `gh secret set ANDROID_KEY_ALIAS --body upload` |
| `ANDROID_KEY_PASSWORD` | Key password | chosen in `keytool` | `gh secret set ANDROID_KEY_PASSWORD` |
| `PLAY_SERVICE_ACCOUNT_JSON` | Service account key JSON allowed to release to the app | Google Cloud console → IAM → Service accounts → create, add a JSON key; Play Console → Users and permissions → invite the service account with "Release to testing tracks" for Arclight Admin. The app must exist in Play Console and the first AAB is uploaded by hand. | `gh secret set PLAY_SERVICE_ACCOUNT_JSON < play-service-account.json` |
| `GOOGLE_SERVICES_JSON` | Firebase config for FCM (push on Android) | Firebase console → project → add Android app `com.moviemethat.arclight.admin` → download `google-services.json`. Not secret in the strict sense, but kept out of the public repo. | `gh secret set GOOGLE_SERVICES_JSON < google-services.json` |
| `APPSTORE_API_KEY_ID` | App Store Connect API key ID | App Store Connect → Users and Access → Integrations → App Store Connect API → generate a team key with the **Admin** role (needed for cloud-managed signing) | `gh secret set APPSTORE_API_KEY_ID --body ABC123XYZ` |
| `APPSTORE_API_ISSUER_ID` | Issuer ID shown above the key list | same page | `gh secret set APPSTORE_API_ISSUER_ID --body <uuid>` |
| `APPSTORE_API_KEY_P8` | Contents of the downloaded `AuthKey_<ID>.p8` (downloadable once) | same page | `gh secret set APPSTORE_API_KEY_P8 < AuthKey_ABC123XYZ.p8` |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID | developer.apple.com → Account → Membership details | `gh secret set APPLE_TEAM_ID --body ABCDE12345` |

Before the first TestFlight upload: register the App ID `com.moviemethat.arclight.admin` with the Push Notifications capability and create the app record in App Store Connect (see RELEASE-IOS.md). The APNs key and the FCM service account belong to the push relay, not to this repository.

## Not done yet

- **iOS share extension** ("Request in Arclight" from Safari / the IMDb app). It needs a Share Extension target and an App Group (`@capgo/capacitor-share-target` reads what the extension stores), which cannot be built or tested without a Mac. Android's share target works. To add it: create the extension in Xcode, give both targets an App Group (for example `group.com.moviemethat.arclight.admin`), set `plugins.CapacitorShareTarget.appGroupId` in `capacitor.config.ts`, and register the App Group with the App ID.
- iPad layouts are not tuned (the app runs on iPad; the server's web UI is responsive).
