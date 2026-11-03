# Arclight for iOS (native side)

The iOS project for `apps/player` is a Capacitor 8 app using Swift Package Manager
(`App/CapApp-SPM`, managed by `cap sync`). The bundled web UI talks to one app-local native plugin,
`ArclightPlayer`, whose contract is `../src/native/definitions.ts`. Its Swift implementation lives
in `App/App/`:

| File | What it does |
| --- | --- |
| `ArclightPlayerPlugin.swift` | The Capacitor plugin: turns JS calls into native calls and native events into JS events. |
| `PlayerModels.swift` | The contract's value types (tracks, browse nodes, download requests), decoded from the call options. |
| `PlayerEventHub.swift` | Routes events to the plugin and queues the ones that must not be lost while no WebView is attached. |
| `AudioEngine.swift` | `AVQueuePlayer` playback: current + next track queued for gapless changes, audio session, interruptions, route changes, repeat, rate, sleep timer, remote next/previous fallback. |
| `NowPlayingController.swift` | Lock screen / Control Center / CarPlay "Now Playing" (`MPNowPlayingInfoCenter`) and the remote buttons (`MPRemoteCommandCenter`). |
| `ArtworkLoader.swift` | Cover images with the request headers JS provides, cached in memory. |
| `DownloadManager.swift` | Background `URLSession` downloads with resume data, Wi-Fi-only, persistence across relaunches. |
| `CarPlay.swift` | CarPlay audio scene: tab bar, browse lists, Now Playing. |
| `CastController.swift` | AirPlay state (`castState`) and the system route picker. |
| `TokenVaultPlugin.swift` | The app-local `ArclightVault` plugin: device tokens as Keychain items that stay on this device (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced). |
| `MainViewController.swift` | The bridge view controller; registers the plugins. |

Build it like any Capacitor app:

```sh
pnpm --filter @arclight/player-app sync:ios
open apps/player/ios/App/App.xcodeproj   # pick a team under Signing & Capabilities to run on a device
```

CI (`.github/workflows/player-app-ios.yml`) builds an unsigned simulator build on every change.

## Audio

- The audio session uses the `.playback` category with the long-form audio route-sharing policy
  (the same routing as Music and Podcasts). `UIBackgroundModes` contains `audio`, so playback
  continues with the screen locked.
- When headphones or a Bluetooth device disconnect, playback pauses. After a phone call or Siri,
  playback resumes if iOS says it should.
- Stream URLs get their request headers through the `AVURLAssetHTTPHeaderFieldsKey` asset option.
  Local files are played from absolute paths or `file://` URLs. A missing file is reported as
  `file`.
- The lock screen shows previous / next for music and skip back / forward for audiobooks (or
  whatever `configureRemote` asked for). For audiobooks it also offers the playback rate control.
- `next` / `previous` from the lock screen or the car go to JS first. If JS does not call
  `load` / `skipTo` within 2 s (for example while the WebView is suspended), native moves within
  its own queue and reports `trackChanged` with reason `remote`.

## Downloads

- Two background sessions, `<bundle id>.downloads` and `<bundle id>.downloads.wifi`. The second
  one never uses cellular or "expensive" networks (personal hotspot) and serves Wi-Fi-only
  downloads. When the policy changes, running tasks move between sessions through resume data.
- iOS keeps downloading while the app is suspended. When a download finishes while the app is not
  running, iOS relaunches it in the background, and `AppDelegate` passes the event to
  `DownloadManager`.
- Files are stored under `Library/Application Support/arclight-downloads/<destName>`, excluded
  from iCloud backup. The absolute path is returned in `downloadCompleted.path` (and as a
  `file://` URL in `uri`). Application Support is used instead of Documents so the files are not
  shown in the Files app and are not mixed with user documents.
- The task list (`listDownloads`) is saved in `Application Support/arclight-downloads-state.json`.
  Completed entries are kept for a week. Calling `enqueueDownload` again for a failed id retries it.

## CarPlay

CarPlay audio apps need the `com.apple.developer.carplay-audio` entitlement, which Apple grants on
request. Until it is granted, an app signed with it fails to sign. For that reason the entitlement
is **off by default**:

- `App/App/App.entitlements` contains the entitlement.
- The target's build setting `CARPLAY_ENABLED` (default `NO`) chooses whether it is used:
  `CODE_SIGN_ENTITLEMENTS = $(CARPLAY_ENTITLEMENTS_$(CARPLAY_ENABLED))`, which resolves to
  `App/App.entitlements` for `YES` and to nothing for `NO`.
- `Info.plist` copies the setting into `ArclightCarPlayEnabled`, and `getInfo().features.car`
  reports it, so the UI only offers CarPlay features in builds that have it.
- The CarPlay scene is declared in `Info.plist` in every build. Without the entitlement, iOS never
  connects it, so it does no harm.

To turn CarPlay on:

1. Request the CarPlay audio entitlement from Apple for your developer account
   (developer.apple.com, CarPlay entitlement request).
2. Once it is granted, add the CarPlay audio capability to the App ID and regenerate the
   provisioning profile (or let automatic signing do it).
3. Build with `CARPLAY_ENABLED=YES`: set it under Build Settings → User-Defined for the App
   target, or pass it to `xcodebuild` (`xcodebuild ... CARPLAY_ENABLED=YES`). The value must be
   exactly `YES`.

To test, use the CarPlay window of the iOS Simulator (I/O → External Displays → CarPlay). It
needs a `CARPLAY_ENABLED=YES` build too, but a development profile is enough once Apple has
granted the entitlement.

What the car shows: tabs **Continue**, **Music** (Albums, Artists, Playlists), **Books** and
**Downloads**. Each list asks JS through a `browseRequest` event and waits up to 5 s for
`answerBrowse`. The tree last sent with `setBrowseTree` (saved in
`Application Support/carplay-browse-tree.json`) is shown at once and used when JS does not answer.
When the driver picks a playable row, `browsePlay` goes to JS, and the Now Playing screen opens
once playback starts.

Limitations: starting playback from the car needs the JS side running, because the app builds the
queue and asks the server for stream links. If the WebView is suspended and does not answer, the
car shows a "open Arclight on your iPhone" message. CarPlay voice search (SiriKit
`INPlayMediaIntent`) is not implemented.

## AirPlay and Google Cast

- AirPlay works through the system: `AVPlayer.allowsExternalPlayback` and the long-form audio
  session send audio to whatever route the user picks. `showRoutePicker` opens the system picker,
  and route changes are reported as `castState` events (`kind: 'airplay'`, with the receiver's
  name when connected).
- iOS has no public API to end an AirPlay route from an app. `endCastSession` opens the picker so
  the user can choose this iPhone.
- `showRoutePicker` triggers the button inside a hidden `AVRoutePickerView`, since there is no
  public API to present the picker. If a future iOS changes that view's internals, the call
  rejects with `UNAVAILABLE` and the UI can show its own `AVRoutePickerView`-style hint.
- **Google Cast is not available on iOS.** Google distributes the Cast iOS SDK through CocoaPods
  and as a manual download. There is no official Swift Package, and this project uses SPM only,
  so no casting to Chromecast from iOS. `castState.kind` is never `chromecast` on iOS.

## Keychain

Device tokens are generic-password Keychain items (service `com.moviemethat.arclight.tokens`, one
per account id) written by `TokenVaultPlugin.swift` with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and `kSecAttrSynchronizable` off. They are
readable after the first unlock, so playback in the background can still reach the server, but are
never synced to iCloud Keychain or restored from a backup onto another phone. Versions before
0.24.0 stored them through `@capgo/capacitor-native-biometric`; the JS side (`migratingVault` in
`src/core/accounts.ts`) copies each one to the new item on first read and then deletes the old one,
so nobody is signed out by the upgrade.

## App Transport Security

People connect to their own servers, often over plain `http://` on the home network. `Info.plist`
allows:

- `NSAllowsLocalNetworking`: http to IP addresses, `.local` names and single-label host names
  (the LAN). Apple does not ask for a justification for this one.
- `NSAllowsArbitraryLoadsForMedia`: AVPlayer streams from an http server anywhere.
- `NSAllowsArbitraryLoadsInWebContent`: the bundled UI's API calls (made from the WKWebView) to an
  http server anywhere.

`NSAllowsArbitraryLoads` is deliberately not set (iOS ignores it anyway when any of the keys above
is present). Native downloads (`URLSession`) to a **public** host therefore need HTTPS, while
downloads from LAN servers work over http.

App Store review: the two "arbitrary loads" exceptions may need a short justification in App Store
Connect ("connects to user-hosted media servers whose address the user enters; many run without
TLS on the local network"). A stricter build could drop them and keep only
`NSAllowsLocalNetworking`. That would require https for every server outside the LAN.

Reviewed for 0.24.0 and kept as they are:

- Dropping `NSAllowsArbitraryLoadsInWebContent` would break every http server outside the
  networks that `NSAllowsLocalNetworking` covers (a VPN address, a DNS name for a LAN box), and the
  WebView fetch is how the whole UI talks to the server.
- Dropping `NSAllowsArbitraryLoadsForMedia` would make AVPlayer refuse streams from those same
  servers after sign-in worked.
- ATS cannot tell a host the user allowed from any other host, so the decision is made in the app:
  the cleartext policy in `src/core/transport.ts` (see the player README's Security section). A
  device token never goes to an http host on the internet unless the user typed that host's name,
  and the app prefers https wherever the server answers there.

`NSLocalNetworkUsageDescription` explains the local network prompt that iOS shows the first time
the app reaches a LAN address.
