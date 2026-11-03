# Arclight player for iOS: App Store launch checklist

> **Two apps.** This checklist is for the player app **Arclight** (`com.moviemethat.arclight`, `apps/player`). The companion app for running your server, **Arclight Admin** (`com.moviemethat.arclight.admin`, `apps/mobile`), has its own App Store record and its own checklist: [RELEASE-IOS.md](RELEASE-IOS.md). The membership, agreements, build route and TestFlight steps are the same work as there; do them once and reuse them. The Android side is [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md).

Everything needed to take the Arclight player iPhone and iPad app from an Apple Developer Program membership to a public App Store listing. Work top to bottom. Items marked **(permanent)** cannot be changed after the first upload.

Apple changes requirements every year, usually around WWDC and in the spring. Check App Store Connect Help and the App Review Guidelines before each section.

> **Status of the iOS app today.**
> - **Audio is native.** AVPlayer (gapless queue, background audio, lock screen and Control Center, AirPlay, offline downloads with background `URLSession`, CarPlay audio scene).
> - **Native video on iOS is not implemented yet.** The video methods of the native plugin reject as unimplemented, so on iOS movies and TV play through the web player path (the bundled web player), not a native player. The full-screen native video player, picture-in-picture and the audio/subtitle pickers described for Android are Android-only. Describe the app in the listing as music and audiobooks first, and test the video path in TestFlight before promising it in screenshots.
> - **The Google TV layout is Android-only.** The D-pad and 10-foot layout ships only in the Android build. **Apple TV (tvOS) is not supported** and the project has no tvOS target; do not claim it.
> - **Google Cast is not available on iOS** (no Swift Package from Google). AirPlay is the casting route.
> - **No store CI for the player yet.** `.github/workflows/mobile.yml` builds, signs and uploads **Arclight Admin only**. The player has `.github/workflows/player-app-ios.yml`, an unsigned simulator build. The secrets that workflow uses are listed in section 2 as the pattern a player workflow would follow.

---

## 0. Decisions to make first

- [ ] **Bundle ID (permanent).** `com.moviemethat.arclight` (`PRODUCT_BUNDLE_IDENTIFIER` in `apps/player/ios/App/App.xcodeproj`; Admin's is this plus `.admin`). Use the same ID as the Android application ID. Pairing links use the URL scheme `arclight://pair?server=...&code=...`, declared in `Info.plist`.
- [ ] **App Store name: "Arclight"** (`CFBundleDisplayName` is already "Arclight"). App Store names are **unique across the whole store** and up to 30 characters. A name already taken by anyone, in any category, cannot be used, so **reserve it early** by creating the app record (section 3), before building anything else. Have a fallback ready, for example "Arclight Player" or "Arclight - Your Library".
- [ ] **Subtitle** (30 characters), for example "Your music and audiobooks".
- [ ] **Free, no in-app purchases** (assumed below).
- [ ] **Minimum iOS version.** The project's deployment target is iOS 15.0.
- [ ] **iPhone and iPad.** The target is universal (`TARGETED_DEVICE_FAMILY = 1,2`), so iPad screenshots and an iPad-friendly layout are required. Decide now whether to ship iPad in 1.0; dropping it later is easy, but reviewers test what is declared.
- [ ] **CarPlay in 1.0 or later** (section 4). It does not have to block the first release.

### How the app is built

The player ships its **whole UI inside the app** (Capacitor 8, bundled `dist/`) so it starts and plays downloads with no server in reach. Playback, downloads, Now Playing, AirPlay state and the CarPlay scene are native Swift in `apps/player/ios/App/App/` (see `apps/player/ios/README.md`). The app is a client for the user's own self-hosted server.

## 1. Membership and agreements

- [ ] Apple Developer Program membership active (renews yearly; the app is removed from sale if it lapses). Same membership as Arclight Admin.
- [ ] App Store Connect, Business: **Free Apps agreement** accepted (and any updated Program License Agreement; uploads are blocked until accepted).
- [ ] **EU Digital Services Act trader status** declared (App Store Connect, Business). A free, non-commercial hobby project can usually declare non-trader; read Apple's guidance and decide before submitting, or EU availability is blocked.
- [ ] Two-factor authentication on the Apple Account.

## 2. Building without a Mac

iOS apps must be built and signed with Xcode on macOS. The Admin guide's route applies unchanged:

- [ ] Build route chosen:
  - **GitHub Actions macOS runners:** free for public repositories; build, sign and upload to App Store Connect from Windows with an App Store Connect API key stored as encrypted secrets. This is how Admin does it.
  - Or a Mac (or a cloud Mac rental) with Xcode, or a hosted service such as Codemagic.
- [ ] Builds use the Xcode and iOS SDK version Apple currently requires for uploads (Xcode 26 / iOS 26 SDK as of 2026; check "Upcoming requirements" in the developer news).

### Store CI: what exists and what would be needed

`.github/workflows/player-app-ios.yml` only builds an unsigned simulator build. There is **no player workflow that signs or uploads**. The `ios` job of `.github/workflows/mobile.yml` is the pattern to copy (point it at `apps/player`, scheme `App`, archive name `ArclightPlayer.xcarchive`). It uses these repository secrets, and a player workflow would use the same names:

| Secret | Used for |
| --- | --- |
| `APPSTORE_API_KEY_ID` | App Store Connect API key ID |
| `APPSTORE_API_ISSUER_ID` | API issuer ID |
| `APPSTORE_API_KEY_P8` | Contents of the `.p8` private key; written to a temp file and deleted after the run |
| `APPLE_TEAM_ID` | Apple Developer team ID |

Signing is cloud-managed: `xcodebuild -allowProvisioningUpdates` with the API key, so there are no certificates or profiles to store. The build number is the CI run number (`CURRENT_PROJECT_VERSION`). The key needs the Admin role (or App Manager with access to cloud-managed distribution certificates). The Android secrets are in [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md).

- [ ] Decision: first builds from a Mac / Codemagic, or add the player workflow first.

## 3. Identifiers, capabilities and the app record

- [ ] **App ID** registered (Certificates, Identifiers & Profiles > Identifiers) with the bundle ID `com.moviemethat.arclight`. Capabilities to enable:
  - **Background Modes:** *Audio, AirPlay, and Picture in Picture*. This is the one Apple capability behind both background audio and AirPlay; there is no separate AirPlay entry. `Info.plist` already has `UIBackgroundModes` `audio`, `fetch` and `processing` (the last two for resuming downloads and the sync task `com.moviemethat.arclight.sync`); you must be able to justify `fetch` and `processing` to review (offline progress sync and download maintenance).
  - **CarPlay audio** (`com.apple.developer.carplay-audio`): see below. Not available until Apple grants it.
  - No Push Notifications (the player does not use push), no Sign in with Apple.
- [ ] **App Store Connect API key** (Users and Access > Integrations) for CI uploads; Issuer ID, Key ID and the `.p8` stored as GitHub secrets (section 2).
- [ ] **App Store Connect app record** created: platform iOS, name **Arclight**, primary language, bundle ID, SKU (any internal string, for example `arclight-player-ios`), full access. This reserves the name. Do this first.

### CarPlay audio: Apple has to grant it first

CarPlay is **not a checkbox**. The `com.apple.developer.carplay-audio` entitlement is granted by Apple to a specific developer team after you submit the **CarPlay entitlement request form** (developer.apple.com, CarPlay, "Request the CarPlay entitlement"; choose the audio app category and describe the app). Approval can take days to weeks and Apple may ask questions. Until it is granted, a build signed with the entitlement **fails to sign**, so nothing can ship or even run on a device with it.

For that reason the project keeps the entitlement **off by default**:

- `apps/player/ios/App/App/App.entitlements` contains the entitlement.
- The build setting `CARPLAY_ENABLED` (default `NO`) decides whether `CODE_SIGN_ENTITLEMENTS` points at that file. `Info.plist` copies it into `ArclightCarPlayEnabled`, and the app only offers CarPlay features when it is on.
- The CarPlay scene is declared in `Info.plist` in every build, but iOS never connects it without the entitlement, so it does no harm.

**The app can launch without CarPlay while the request is pending.** Submit 1.0 with `CARPLAY_ENABLED=NO`, then ship CarPlay in an update.

- [ ] CarPlay entitlement request form submitted early (it runs on its own clock), with the same team that will sign the app. Use a description such as: "Audio app for a self-hosted media server: browse the user's music and audiobooks and play them in the car."
- [ ] Once granted: the CarPlay audio capability added to the App ID, the provisioning profile regenerated (or left to cloud-managed signing), and a build made with `CARPLAY_ENABLED=YES` (exactly `YES`; set in Build Settings > User-Defined or pass it to `xcodebuild`).
- [ ] Tested in the Simulator's CarPlay window (I/O > External Displays > CarPlay) and on a real head unit if possible: tabs Continue, Music, Books, Downloads; playback from the car; Now Playing; the "open Arclight on your iPhone" message when the app is not running.
- [ ] CarPlay review: Apple reviews CarPlay behaviour against its CarPlay App Programming Guide. Use only the audio templates, no custom UI, and keep list depth short.

## 4. Project setup, permissions and network

- [ ] Version (`MARKETING_VERSION`, currently `1.0`) and build number (`CURRENT_PROJECT_VERSION`, increased on every upload). Keep the marketing version in line with `apps/player/package.json`.
- [ ] **Local network permission:** `NSLocalNetworkUsageDescription` is set ("Arclight connects to your Arclight server on your local network to stream and download your music and audiobooks."). Add `NSBonjourServices` only if LAN discovery is implemented; it is not today. Review will read this text: it must match what the app does.
- [ ] **Camera:** `NSCameraUsageDescription` is set (scanning the pairing QR code). The camera is optional; typing the server address and password also works.
- [ ] **App Transport Security.** `Info.plist` has `NSAllowsLocalNetworking`, `NSAllowsArbitraryLoadsForMedia` and `NSAllowsArbitraryLoadsInWebContent`; `NSAllowsArbitraryLoads` is deliberately not set. That allows plain `http://` to LAN servers (no justification needed), to AVPlayer streams from an HTTP server anywhere, and to the bundled UI's API calls from the WebView. Native downloads (`URLSession`) to a **public** host stay HTTPS-only. The two "arbitrary loads" exceptions **need a justification in App Store Connect**: "Connects to user-hosted media servers whose address the user enters; many run without TLS on the local network." A stricter build could drop them and keep only `NSAllowsLocalNetworking`, which would require HTTPS for every server outside the LAN. Reviewed for 0.24.0 and kept; the app's own cleartext policy decides which hosts get a sign-in (see `apps/player/ios/README.md`).
- [ ] **Privacy manifest** (`PrivacyInfo.xcprivacy`). **The app target has none today.** `DownloadManager.swift` uses `UserDefaults`, a required-reason API, so add a manifest to the app target that declares no tracking, no collected data types, and `NSPrivacyAccessedAPICategoryUserDefaults` (reason `CA92.1`), plus any other required-reason API the build report lists (file timestamps and disk space are common with download managers). Capacitor and its plugins ship their own manifests; read the aggregated report from the archive (Product > Archive > Generate Privacy Report). Missing declarations produce warning emails and can block uploads.
- [ ] **Export compliance.** `ITSAppUsesNonExemptEncryption` is already `false` in `Info.plist` (standard HTTPS only), so the question is skipped on every upload. Keep it true to the code: if the app ever adds its own encryption, change it and file the paperwork.
- [ ] No ads, analytics or tracking SDKs, so no App Tracking Transparency prompt.
- [ ] Sign-in tokens live in the Keychain (the app's `TokenVaultPlugin.swift`, this device only, no iCloud sync), not plain storage.
- [ ] Licenses screen (GPL-3.0; link to the source).
- [ ] iPad: all four orientations are declared; the app must work in landscape and in iPad multitasking sizes (or declare `UIRequiresFullScreen`).
- [ ] App icon and launch screen present in `Assets.xcassets` (1024 x 1024, no transparency; **waiting on the new logo**).

## 5. Things App Review needs

App Review must be able to use the app without your home network. The player is a client for a self-hosted server, so **it shows nothing useful without one.**

- [ ] **Demo server** online at a stable HTTPS address (this page uses `https://demo.example.com`; use your own domain), separate from any personal server:
  - a sample library of public-domain or self-made content only (music, an audiobook), so everything in the screenshots works;
  - no indexers and no download clients configured;
  - the player app enabled for the reviewer account (the server admin controls who may use it);
  - a **reviewer account**, and optionally a **pairing code** that stays valid during review;
  - online for every review, including every update.
- [ ] **Privacy policy URL**: https://arclight.moviemethat.com/legal/privacy/ (privacy label summary: https://arclight.moviemethat.com/legal/app-privacy/). Check those pages cover the player app: what it stores (server address, device token, download index) and where it goes (only the user's own server).
- [ ] **Support URL**: https://arclight.moviemethat.com/support/; marketing URL: https://arclight.moviemethat.com/; terms: https://arclight.moviemethat.com/legal/terms/
- [ ] Guidelines checked against the app:
  - **4.2 Minimum functionality.** The player is not a wrapped website, and the review notes should say so. It ships its own UI and uses native capabilities a website cannot: AVPlayer gapless audio with background playback, lock screen and Control Center controls, **offline downloads** that play with no network (including airplane mode), **CarPlay** (when enabled) and **AirPlay**, Keychain storage and QR pairing. Point the reviewer at downloading an album and playing it in airplane mode.
  - **5.2.3 Audio/video downloading.** The app only downloads from the user's own server. Reviewer-visible content is legal sample media; no indexer search in the reviewer's path.
  - **5.1.1 Data collection:** no sign-up in the app (accounts live on the user's server), so in-app account deletion is not required. If sign-up is ever added, account deletion must be added too.
  - **2.5.4 Background modes:** audio, and fetch/processing, are all used for what the descriptions say.
  - **TMDB attribution:** if posters or metadata from TMDB are shown, the TMDB logo and notice appear (for example in About).

## 6. App Store Connect: App information and privacy

- [ ] Category: primary **Music** (or Entertainment), secondary optional.
- [ ] **Age rating** questionnaire answered (Apple's updated ratings: 4+, 9+, 13+, 16+, 18+). The app shows whatever the user's server contains, so answer the unrestricted web content and user content questions honestly; 16+ or 18+ is likely.
- [ ] Content rights: "Does your app contain, show or access third-party content?" Yes (artwork and metadata from the user's server and TMDB); confirm the content is the user's own.
- [ ] **App Privacy** ("nutrition label"):
  - data used to track you: **none**;
  - data linked to you: **none collected by the developer**; there is no analytics, ads or crash SDK and the app talks only to the user's own server;
  - nothing else, because the player does not use push and has no developer-run backend.
- [ ] Privacy policy URL entered.

## 7. Version page and media

- [ ] **iPhone screenshots**: 6.9" set (1320 x 2868 or 1290 x 2796 portrait), 1 to 10 images; Apple scales them for smaller iPhones. **iPad 13" set** (2064 x 2752). Use the demo server's sample library. Do not show screens that only exist on Android (full-screen video, Google TV).
- [ ] App preview video (optional).
- [ ] Promotional text (170 characters, editable without review).
- [ ] Description (4,000 characters): a player for your own Arclight server, with offline downloads, background playback, AirPlay and (when enabled) CarPlay. State that **a server is required**. No mention of piracy or copyrighted titles. Do not mention Apple TV, Google TV or Chromecast.
- [ ] Keywords (100 characters, comma-separated, no spaces after commas; do not repeat the app name or use competitors' names).
- [ ] Support URL, marketing URL, copyright line ("2026 Arclight contributors").
- [ ] App icon: 1024 x 1024 PNG, no transparency, no rounded corners (iOS rounds it) (**waiting on the new logo**). iOS 18+ also supports dark and tinted icon variants.

## 8. TestFlight

- [ ] First build uploaded (CI or Xcode Organizer) and processed.
- [ ] Export compliance answered (skipped because it is set in `Info.plist`).
- [ ] **Internal testing**: up to 100 people in your App Store Connect team; no review needed. Test: add a server over HTTP on the LAN and HTTPS, the local network prompt, password and pairing-code sign-in, audio playback, background and lock-screen controls, gapless, downloads and airplane-mode playback, AirPlay, **video through the web player path** (confirm it plays, or hide video in this release), iPad layout and rotation, CarPlay (if enabled).
- [ ] **External testing** (optional, up to 10,000 testers via email or public link): needs Beta App Review; fill in the test information and the demo account.
- [ ] Crashes and feedback from TestFlight fixed.

## 9. Submit for review

- [ ] Build selected on the 1.0 version page.
- [ ] **App Review Information**: sign-in required, so enter the demo username and password. Notes, for example: "Arclight is a client for a self-hosted media server. On first launch tap Add server, enter https://demo.example.com, then sign in with the account above. The demo server contains public-domain sample media only. To see the native features: download an album, switch on airplane mode and play it; lock the phone to use the lock-screen controls. CarPlay is not enabled in this version." (Adjust the last sentence to the build.) Contact name, phone and email (not shown publicly).
- [ ] Justification for the ATS exceptions entered if App Store Connect asks (section 4).
- [ ] Release option: **manual release** for the first version, or automatic.
- [ ] Phased release for updates (7-day automatic rollout) considered.
- [ ] Pricing and availability: Free, countries chosen. EU availability needs the DSA trader declaration (section 1).
- [ ] Submitted. Reviews usually take 1 to 3 days; answer any rejection in Resolution Center, change what is asked, resubmit.

## 10. After launch

- [ ] Install from the App Store on a clean iPhone and iPad to confirm.
- [ ] Crash reports (Xcode Organizer / App Store Connect) watched.
- [ ] CarPlay: when Apple grants the entitlement, ship the `CARPLAY_ENABLED=YES` update and re-test in the car.
- [ ] Native iOS video: when it lands, update the screenshots, the description and this page.
- [ ] Each update: build number increased, "What's New" text, demo server still online, new Apple requirements met (a new SDK minimum each spring).
- [ ] Membership renewed every year; distribution certificates renewed before they expire (cloud-managed signing does this for you); agreements re-accepted when Apple updates them.
