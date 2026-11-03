# Arclight player: store review notes

Text ready to paste into App Store Connect and Google Play Console for the player app **Arclight** (`com.moviemethat.arclight`, `apps/player`). The launch checklists are [RELEASE-PLAYER-IOS.md](RELEASE-PLAYER-IOS.md) and [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md); they say where each answer goes.

Before each submission, check every answer against the build you are submitting: `apps/player/ios/App/App/Info.plist`, `PrivacyInfo.xcprivacy`, `apps/player/android/app/src/main/AndroidManifest.xml` and `res/xml/network_security_config.xml`. If a setting below is no longer in the build, delete its paragraph instead of submitting it.

The demo server address on this page is `https://demo.example.com`; use your own.

---

## App Store (iOS)

### App Transport Security

Arclight is a client for the user's own self-hosted media server. Users enter their server's address themselves, and many of these servers run on the home network without TLS. `NSAllowsArbitraryLoads` is not set; the exceptions are:

| Key | Why |
| --- | --- |
| `NSAllowsLocalNetworking` | Self-hosted servers on the LAN, reached by IP address, `.local` name or single-label host name. |
| `NSAllowsArbitraryLoadsForMedia` | AVPlayer streams music, audiobooks and video from the user's own server, which may be plain HTTP on the LAN or behind a reverse proxy. |
| `NSAllowsArbitraryLoadsInWebContent` | The bundled UI calls the user's own server. Users connect to their own self-hosted server by IP or local hostname. |

Paste into the ATS justification field if App Store Connect asks:

> Arclight is a client for a media server that the user hosts themselves. The user types their server's address; it is never a server we run. Many self-hosted servers are on the home network and have no TLS certificate, so the app must reach them by IP address or local host name over HTTP. Users connect to their own self-hosted server by IP or local hostname. The app does not load third-party web content, and it sends no data to the developer.

### Background modes

`UIBackgroundModes` is `audio` only.

> Arclight plays the user's music and audiobooks from their own server or from offline downloads. The audio background mode keeps playback going with the screen locked or another app open, with lock-screen and Control Center controls. Downloads use background URLSession transfers, which need no background mode.

### Local network

`NSLocalNetworkUsageDescription`: "Arclight connects to your Arclight server on your local network to stream and download your music and audiobooks."

> The app asks for local network access because the user's media server is usually on their home network. It only connects to the address the user enters or pairs with; it does not browse or scan the network.

### Camera

`NSCameraUsageDescription`: "Arclight uses the camera to scan the pairing QR code shown by your Arclight server."

> The camera is used only to scan the pairing QR code that the user's own server shows. It is optional: the user can type the server address and sign in with a password or a pairing code instead. No images are stored or sent.

### App Privacy and the privacy manifest

- Data used to track you: **none**. Data linked to you: **none**. Data not linked to you: **none**.
- `PrivacyInfo.xcprivacy` declares no tracking, no tracking domains and no collected data types. Arclight sends data (sign-in, listening progress, downloads) only to the user's own server, which is not collection by the developer. There is no analytics, advertising or crash-reporting SDK, and no developer-run backend.
- Required-reason APIs declared: UserDefaults `CA92.1`, file timestamps `C617.1`, disk space `E174.1` and `85F4.1` (see RELEASE-PLAYER-IOS.md, section 4).

> Arclight has no account system of its own and no developer backend. Everything the app sends goes to the media server whose address the user enters, which the user runs themselves. We do not receive or collect any data.

### Export compliance

`ITSAppUsesNonExemptEncryption` is `false`: the app uses only the system's standard HTTPS.

### Notes for the reviewer (App Review Information)

> Arclight is a client for a self-hosted media server. On first launch tap Add server, enter https://demo.example.com, then sign in with the account above. The demo server contains public-domain sample media only. To see the native features: download an album, switch on airplane mode and play it; lock the phone to use the lock-screen controls. CarPlay is not enabled in this version.

Change the last sentence when a build ships with `CARPLAY_ENABLED=YES`.

---

## Google Play (Android)

### Data safety

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **No.** The app sends data only to the user's own server (and to the Cast device the user picks). The developer receives nothing. |
| Is all of the user data collected by your app encrypted in transit? | Answer per Play's definition of collected data (none). Where a note is possible: traffic to the user's server uses HTTPS when the server has it; self-hosted servers on a home network may use plain HTTP. |
| Do you provide a way for users to request that their data is deleted? | No data is collected. Signing out removes the device token; downloads are deleted in the app; uninstalling removes everything. Data deletion URL: https://arclight.moviemethat.com/legal/data-deletion/ |
| Ads, analytics, crash reporting | None. |
| Account creation | The app creates no accounts; accounts live on the user's own server. |

> Arclight is a client for a media server that the user hosts themselves. It has no developer backend and no analytics, advertising or crash-reporting SDK. Sign-in details, listening progress and downloads go only to the server address the user enters. We do not collect or share user data.

### Cleartext traffic

The manifest and `network_security_config.xml` decide which hosts may use plain HTTP; check them before pasting. Justification if a reviewer asks:

> Users connect to their own self-hosted server by IP or local hostname. Many of these servers run on the home network without a TLS certificate, so the app must be able to reach them over HTTP. The app only connects to the address the user enters.

### Foreground services

See RELEASE-PLAYER-ANDROID.md, section 8, for the `mediaPlayback` and `dataSync` declarations and the videos Play asks for.

### Camera

> The camera is used only to scan the pairing QR code that the user's own server shows. It is optional (`required="false"`), asked for at runtime, and the server address and password can be typed instead. No images are stored or sent.
