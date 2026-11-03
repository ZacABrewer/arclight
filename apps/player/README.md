# Arclight for iOS and Android (listening app)

`@arclight/player-app` plays music and audiobooks from your own Arclight server. It also downloads them for offline listening and keeps your place across devices. Its whole UI ships inside the app (Capacitor 8), so it starts and plays downloads with no server in reach. Playback runs in a native player plugin (ExoPlayer/Media3 on Android, AVPlayer on iOS). That gives you lock-screen and headset controls, background audio, gapless playback, Android Auto and CarPlay.

This is not the companion app in `apps/mobile`, which wraps the server's own web UI for admins and requests. The two apps are separate packages.

## Using it

1. **Add a server.** Scan the pairing QR code from the server, or type its address. Typed addresses are resolved and probed the way the companion app does it (`src/core/address.ts`, `src/core/probe.ts`). Errors tell you which case you hit: unreachable, timed out, TLS not trusted, or "not Arclight". Plain HTTP to a host outside the LAN needs "Connect anyway".
2. **Sign in.** Two ways:
   - **Password**, then the authenticator code if the account has two-factor on (a recovery code works too).
   - **Pairing code**: in the web player (`/player`), open *Sign in to the Arclight app*. It shows a QR code (`arclight://pair?server=<url>&code=<code>`) and an 8-character code. Scanning it, or opening the link from the camera app, signs in without typing a password. A server that requires pairing for the app answers a password sign-in with `PAIRING_REQUIRED`, and the app then switches to the code step.
3. **Accounts.** You can add any number of accounts, on one server or several, and switch between them in Settings. Each account has its own token, downloads and pending progress.

The admin decides who may use the app (player settings on the server). If the player is off, or the account isn't allowed to use it, the app shows that instead of the library.

## Development

```sh
pnpm install
pnpm --filter @arclight/server dev        # or any reachable Arclight server
cd apps/player
pnpm dev                                   # http://localhost:5175
```

`vite dev` proxies `/api` to `VITE_API_TARGET` (default `http://localhost:7878`). In "Add server", enter the dev server's own address (`http://localhost:5175`). In a browser the app falls back to an HTML audio engine and keeps tokens in session storage, which is fine for working on screens. Native playback, downloads and secure storage need a device or emulator.

```sh
pnpm typecheck     # tsc, including the reused web modules and the tests
pnpm test          # vitest (jsdom)
pnpm build         # dist/
pnpm sync:android  # build + npx cap sync android
pnpm sync:ios      # build + npx cap sync ios
```

Android builds need **JDK 21** (Capacitor 8) and the Android SDK: `cd android && ./gradlew assembleDebug`. iOS builds need Xcode on macOS: open `ios/App/App.xcodeproj`.

To try the TV build, create an Android TV emulator (API 34 or later) in Android Studio and install the debug APK with `adb install -r`.

## How it is built

```
 src/ui        app screens: onboarding, shell (top bar, mini-player, tabs), downloads, settings
 src/tv        TV stage, focus engine, Back handling, the TV screens (tv/screens)
 src/households  profiles: picker gate, PIN entry, profile settings
 src/intro     the launch intro (cold launch only)
 src/app       router (hash history), services (accounts, query client, player controller)
 src/core      API client (Bearer), accounts + token vault, sign-in, address probing, QR links
 src/offline   download manager + index, offline progress queue
 src/player    NativeEngine: the web player's engine interface on top of the native plugin
 src/native    ArclightPlayer plugin contract (definitions.ts) and its web fallback
 apps/web/src/features/player   reused as-is (browse pages, now playing, queue, mini-player)
```

- **Reusing the web player.** The browse pages, now-playing screen, queue and design system come from `apps/web` through the `@web` alias. They are never copied or edited. `vite.config.ts` swaps one web module at build time: `api/client.ts` becomes `src/web-shims/api-client.ts`, which adds the server base URL and `Authorization: Bearer`. Only the player, design-system and common message keys from the web locale files are bundled. The app's own strings live in `src/i18n/locales/<code>.json` under `app.`.
- **Auth.** `POST /api/v1/app/sign-in` (password and optional `totp`) and `POST /api/v1/app/pair` (code) return a device token. The token lives in the Keychain on iOS (the app's own `ArclightVault` plugin, `ios/App/App/TokenVaultPlugin.swift`) or in Keystore-backed storage on Android (`@capgo/capacitor-native-biometric`), never in Preferences. Account metadata (server, user, device id) goes in Preferences. A `401` on a signed-in request marks the account expired and sends you to sign in again, keeping its downloads. Signing out calls `POST /api/v1/app/sign-out` and deletes the token.
- **Artwork.** The server signs artwork URLs (`POST /api/v1/playback/artwork-link`), so `<img>` works without cookies. The signature is cached and refreshed before it expires.
- **Native plugin.** `src/native/definitions.ts` is the contract between the TS layer and the Swift and Kotlin plugins. It covers queue loading with gapless upcoming tracks, transport, remote and lock-screen commands, the sleep timer, background downloads, storage info, the Auto/CarPlay browse tree and cast state. `NativeEngine` maps it onto the web player's engine interface, so the shared `PlayerController` (queue, shuffle, repeat, progress reporting) runs unchanged. Lock-screen next and previous go back to the controller. Expired stream links are refetched once, and an unsupported codec falls back to a transcode.
- **Video (Android).** Movies and TV play in a full-screen native activity (`android/.../video/VideoActivity.java`, Media3). The TS layer decides direct play, remux or transcode, then calls `playVideo`. The device's decoders are reported through `getDeviceInfo().videoProfile`, read from `MediaCodecList`: H.264, HEVC (including Main10), AV1, VP9, HDR types and audio passthrough. Supported containers are MKV, MP4 and WebM. The player shows:
  - WebVTT subtitles.
  - Audio and subtitle pickers.
  - Chapters.
  - Skip intro/credits.
  - An up-next card with a 10-second countdown.
  - Resume.
  - A media session.
  - Picture-in-picture, on phones only.

  A remuxed or transcoded stream starts at `streamStartMs`. Times sent to JS are always media time, and subtitle cues are shifted to match the stream. On a stream that can't seek, a seek sends `videoSeekRequest`, and JS answers with `replaceVideoStream`. Events: `videoProgress` (about every 10 s and on pause), `videoSeekRequest`, `videoNext` and `videoClosed`. Starting a video pauses audio playback. iOS rejects the video methods as unimplemented for now; in a browser, the web player plays video itself.
- **TV layout.** On a TV (`tv/tv-mode.ts`) the app draws the design's 10-foot screens on a fixed 1920x1080 stage scaled to the screen (`tv/stage.tsx`): Home with the rotating hero, TV Shows, Movies, My List, a title's detail, Search with the on-screen keyboard, Music, Audiobooks, Listen (now playing), Settings, and "Who's watching?" with its PIN pad. The screens live in `tv/screens/`. Focus moves with the D-pad through `tv/focus-manager.ts`, which keeps left/right inside a row, scrolls rows and pages smoothly (off with Reduce motion) and remembers the focused item per page. Back is handled in `tv/tv-runtime.ts`. On phones the same routes render the portrait pages, with Home, TV Shows, Movies, My List and Search as tabs and Music, Audiobooks and the profile avatar in the top bar. See [docs/player/app.md](../../docs/player/app.md).
- **Google TV / Android TV.** The same APK installs on TV. It has a Leanback launcher entry and a 320x180 banner (generated by `scripts/generate-assets.mjs`), and every phone-only hardware feature is declared optional. On TV the WebView gets focus at start-up. The D-pad arrows reach the web UI as arrow keys, OK becomes Enter, and Back goes to the app's `backButton` handler. In the video player, left/right scrub, OK plays or pauses (or presses the visible Skip button), up/down show the controls, and Back closes the player.
- **Downloads.** Stream links are requested with `download: true` and handed to the native downloader, which keeps running in the background and survives app restarts. A JSON index tracks each item's parts and shared album artwork, per account. Downloaded items play from local files, including in airplane mode. Settings cover quality, Wi-Fi only, a storage limit and space to keep free.
- **Offline progress.** Progress reports that can't reach the server are queued in Preferences. Ticks are coalesced, pauses and stops are kept. The queue is flushed with `POST /api/v1/playback/progress/batch` when the app resumes or the network returns. Servers without the batch endpoint get single `PUT`s instead.

## Security

- **Plain http (`src/core/transport.ts`).** Android (`usesCleartextTraffic`, `network_security_config.xml`) and iOS (App Transport Security, see [ios/README.md](ios/README.md#app-transport-security)) allow plain `http://`, because home servers rarely have certificates. The rule lives in the API client instead:
  - `https://` is always fine.
  - `http://` to the home network is fine after a one-time notice per host that the traffic is not encrypted. `classifyHost` (`src/core/address.ts`) decides what counts: loopback, the private IPv4 ranges (10/8, 172.16/12, 192.168/16), link-local, CGNAT/Tailscale (100.64/10), IPv6 ULA and link-local, single-label names and `.local`, `.lan`, `.home`, `.internal`, `.home.arpa`, `.localdomain` and `.ts.net`.
  - `http://` to a host on the internet needs the user to type that host name once. The answer is kept per host name (any port).
  - The app tries `https://` first, also when the user typed `http://`, and keeps it when an Arclight server answers there. Once a host has answered over https it is pinned: going back to http there asks for the typed confirmation again, even on the home network.
  - `request()` in `src/core/api.ts` refuses to send a device token, password or pair code (`/app/*`) to an address the policy does not allow (`INSECURE_TRANSPORT`), so a missed screen cannot leak one.
  - Pairing links and QR codes go through the same check. `arclight://pair` opens sign-in with the server's host and whether it is encrypted, and pairs only after the user presses Pair.
  - Accounts saved by an earlier version on a public http server are asked once (`/secure-server`): the app moves them to https when the server answers there, otherwise the user types the host name. Nothing is signed out.
- **Mixed content.** `allowMixedContent` stays `true` in `capacitor.config.ts`. The UI is served from `https://localhost`, so every `fetch` to an http home server is active mixed content, and only `MIXED_CONTENT_ALWAYS_ALLOW` lets it through (compatibility mode allows only images and media). The CSP in `index.html` still blocks http scripts, frames and plugins (`script-src 'self'`, `frame-src 'none'`, `object-src 'none'`).
- **WebView logging.** `loggingBehavior: 'none'`: plugin calls are not written to logcat or the Xcode console, so signed stream and artwork links never end up in logs, also not in debug builds handed to testers.
- **Android Auto and other controllers.** `PlaybackService` is exported so the system can bind to it. `car/ControllerPolicy.java` decides who gets what: the app itself, system and Bluetooth processes and trusted controllers get the browse tree; Android Auto and Android Automotive hosts and Google Assistant (voice control in the car) get it only when the package belongs to the calling uid and is a system app or installed from Google Play; the legacy `MediaController` stand-in gets playback controls only; every other app is turned away.
- **FileProvider.** `res/xml/file_paths.xml` shares only `Android/data/<package>/files/Pictures/`, where the WebView puts camera captures for a file input. Downloads, the cache and the rest of storage are not reachable through it.
- **Backups.** `allowBackup="false"`: tokens and downloads do not move to another device. On iOS the tokens are Keychain items with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and no iCloud sync. Tokens saved by earlier versions are moved to those items the first time they are read (`migratingVault` in `src/core/accounts.ts`).

## CI

`.github/workflows/player-app.yml` runs on changes to this package, to the web player it reuses and to `packages/shared`. It runs typecheck and tests, builds an Android debug APK (uploaded as an artifact) and an unsigned iOS simulator build.
