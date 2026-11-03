# Arclight player for iOS: App Store launch checklist

> **Two apps.** This checklist is for the player app **Arclight** (`com.moviemethat.arclight`, `apps/player`). The companion app for running your server, **Arclight Admin** (`com.moviemethat.arclight.admin`, `apps/mobile`), has its own App Store record and its own checklist: [RELEASE-IOS.md](RELEASE-IOS.md). The membership, agreements, build route and TestFlight steps are the same work as there; do them once and reuse them. The Android side is [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md).

Everything needed to take the Arclight player iPhone and iPad app from an Apple Developer Program membership to a public App Store listing. Work top to bottom. Items marked **(permanent)** cannot be changed after the first upload.

Apple changes requirements every year, usually around WWDC and in the spring. Check App Store Connect Help and the App Review Guidelines before each section.

> **Status of the iOS app today.**
> - **Audio is native.** AVPlayer (gapless queue, background audio, lock screen and Control Center, AirPlay, offline downloads with background `URLSession`, CarPlay audio scene).
> - **Native video on iOS is not implemented yet.** The video methods of the native plugin reject as unimplemented, so on iOS movies and TV play through the web player path (the bundled web player), not a native player. The full-screen native video player, picture-in-picture and the audio/subtitle pickers described for Android are Android-only. Describe the app in the listing as music and audiobooks first, and test the video path in TestFlight before promising it in screenshots.
> - **The Google TV layout is Android-only.** The D-pad and 10-foot layout ships only in the Android build. **Apple TV (tvOS) is not supported** and the project has no tvOS target; do not claim it.
> - **Google Cast is not available on iOS** (no Swift Package from Google). AirPlay is the casting route.
> - **Store CI.** `.github/workflows/player-app-release.yml` (manual runs only) archives, signs and uploads the player to App Store Connect; see section 2. `.github/workflows/player-app-ios.yml` runs an unsigned simulator build on every change and checks the version and the privacy manifest. `.github/workflows/mobile.yml` is **Arclight Admin only**.
> - **Review text** ready to paste into App Store Connect (ATS, background modes, local network, camera, privacy) is in [APP-REVIEW-NOTES.md](APP-REVIEW-NOTES.md).

---

## 0. Decisions to make first

- [ ] **Bundle ID (permanent).** `com.moviemethat.arclight` (`PRODUCT_BUNDLE_IDENTIFIER` in `apps/player/ios/App/App.xcodeproj`; Admin's is this plus `.admin`). Use the same ID as the Android application ID. Pairing links use the URL scheme `arclight://pair?server=...&code=...`, declared in `Info.plist`.
- [ ] **App Store name: "Arclight"** (`CFBundleDisplayName` is already "Arclight"). App Store names are **unique across the whole store** and up to 30 characters. A name already taken by anyone, in any category, cannot be used, so **reserve it early** by creating the app record (section 3), before building anything else. Have a fallback ready, for example "Arclight Player" or "Arclight - Your Library".
- [ ] **Subtitle** (30 characters), for example "Your music and audiobooks".
- [ ] **Free, no in-app purchases** (assumed below).
- [ ] **Minimum iOS version.** The project's deployment target is iOS 15.0.
- [ ] **iPhone and iPad.** The target is universal (`TARGETED_DEVICE_FAMILY = 1,2`), so iPad screenshots and an iPad-friendly layout are required. Decide now whether to ship iPad in 1.0; dropping it later is easy, but reviewers test what is declared.
- [ ] **CarPlay in 1.0 or later** (section 3). It does not have to block the first release.

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

### Store CI

`.github/workflows/player-app-release.yml` builds and uploads the player. It runs **only when started by hand** (Actions > Player app release > Run workflow; leave `ios` on, and switch `android` off for an iOS-only run) and only from the `main` branch, never on a push or a pull request, so pull requests (including ones from forks) never reach the signing secrets. The Android half and its inputs are described in [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md), section 3, "Store CI".

The iOS job (`macos-latest`, latest stable Xcode):

1. sets the build number to **the run number + 30000** and writes it with the version into `ios/App/version.xcconfig` (`scripts/ios-version.mjs`; see "Version and build number" in section 4);
2. builds the web assets and runs `npx cap sync ios`;
3. runs `xcodebuild archive` (Release, `CARPLAY_ENABLED=NO`) with cloud-managed signing: `-allowProvisioningUpdates` and the App Store Connect API key, so there are no certificates or profiles to store;
4. checks that `PrivacyInfo.xcprivacy` is in the archived app and that `CFBundleShortVersionString` and `CFBundleVersion` have the expected values;
5. runs `xcodebuild -exportArchive` with `apps/player/ios/ExportOptions-player.plist` (method `app-store-connect`, destination `upload`; the workflow adds the team ID to a temporary copy), which uploads the build to App Store Connect. It appears in TestFlight once processed.

It uses these repository secrets. They belong to the Apple account, not to one app, so they are **the same secrets Arclight Admin uses**:

| Secret | Used for |
| --- | --- |
| `APPSTORE_API_KEY_ID` | App Store Connect API key ID |
| `APPSTORE_API_ISSUER_ID` | API issuer ID |
| `APPSTORE_API_KEY_P8` | Contents of the `.p8` private key; written to `$RUNNER_TEMP` with `umask 077` and deleted at the end of every run |
| `APPLE_TEAM_ID` | Apple Developer team ID |

If any of them is missing, the job only prints a notice. The key needs the Admin role (or App Manager with access to cloud-managed distribution certificates).

Caveats for the first upload:

- [ ] **The App Store Connect app record must exist first** (section 3), with the bundle ID `com.moviemethat.arclight`. Uploads for a bundle ID without an app record fail.
- [ ] The App ID with its capabilities (section 3) must be registered; cloud-managed signing creates the distribution certificate and profile on the first run.
- [ ] The Free Apps agreement must be accepted (section 1), or uploads are refused.
- [ ] Build numbers only grow: CI builds start at 30001, above the locally derived numbers (2300 for 0.23.0). After a CI upload, a build from a Mac for the same version needs `ARCLIGHT_VERSION_CODE` above the last CI number.

## 3. Identifiers, capabilities and the app record

- [ ] **App ID** registered (Certificates, Identifiers & Profiles > Identifiers) with the bundle ID `com.moviemethat.arclight`. Capabilities to enable:
  - **Background Modes:** *Audio, AirPlay, and Picture in Picture*. This is the one Apple capability behind both background audio and AirPlay; there is no separate AirPlay entry. `Info.plist` declares `UIBackgroundModes` **`audio` only**. Downloads use background `URLSession`s, which need no background mode; the app has no background fetch and registers no `BGTaskScheduler` task, so `fetch`, `processing` and `BGTaskSchedulerPermittedIdentifiers` were removed in 0.24. Add them back only together with code that uses them.
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

**The app can launch without CarPlay while the request is pending.** Until Apple grants the entitlement, every build ships **without** it: `CARPLAY_ENABLED` is `NO` in the project, and the store workflow passes `CARPLAY_ENABLED=NO` explicitly. Submit 1.0 like that, then ship CarPlay in an update.

How to request it:

1. Sign in to the developer account as the Account Holder or an Admin of the team that signs the app.
2. Open the CarPlay page on developer.apple.com and choose "Request the CarPlay entitlement" (the CarPlay entitlement request form).
3. Choose the **audio** app category, give the bundle ID `com.moviemethat.arclight`, and describe the app (suggested text in the checklist below). Apple answers by email; it can take days to weeks, and Apple may ask questions.
4. When it is granted, `com.apple.developer.carplay-audio` becomes available to the team: enable the CarPlay audio capability on the App ID.

How to turn it on: build with **`CARPLAY_ENABLED=YES`** (exactly `YES`) **and** a provisioning profile that includes `com.apple.developer.carplay-audio`. `CARPLAY_ENABLED=YES` points `CODE_SIGN_ENTITLEMENTS` at `App/App.entitlements` and sets `ArclightCarPlayEnabled` in `Info.plist`. With cloud-managed signing the profile is regenerated with the new capability on the next archive; with manual signing, regenerate it in Certificates, Identifiers & Profiles. For CI, change `CARPLAY_ENABLED=NO` to `YES` in the archive step of `player-app-release.yml`; for Mac builds, set it in the App target's Release build settings. A `YES` build without the granted entitlement fails to sign.

- [ ] CarPlay entitlement request form submitted early (it runs on its own clock), with the same team that will sign the app. Use a description such as: "Audio app for a self-hosted media server: browse the user's music and audiobooks and play them in the car."
- [ ] Once granted: the CarPlay audio capability added to the App ID, the provisioning profile regenerated (or left to cloud-managed signing), and a build made with `CARPLAY_ENABLED=YES` (exactly `YES`; set in Build Settings > User-Defined or pass it to `xcodebuild`).
- [ ] Tested in the Simulator's CarPlay window (I/O > External Displays > CarPlay) and on a real head unit if possible: tabs Continue, Music, Books, Downloads; playback from the car; Now Playing; the "open Arclight on your iPhone" message when the app is not running.
- [ ] CarPlay review: Apple reviews CarPlay behaviour against its CarPlay App Programming Guide. Use only the audio templates, no custom UI, and keep list depth short.

## 4. Project setup, permissions and network

- [ ] **Version and build number.** They follow `apps/player/package.json`, the same as Android, so there is nothing to edit by hand:
  - `MARKETING_VERSION` is `$(ARCLIGHT_VERSION)` and `CURRENT_PROJECT_VERSION` is `$(ARCLIGHT_BUILD)` (Debug and Release). Both come from `apps/player/ios/App/version.xcconfig`, which `debug.xcconfig` and `release.xcconfig` include.
  - `version.xcconfig` is written by `apps/player/scripts/ios-version.mjs`. The version is package.json's without any pre-release suffix (App Store versions are digits and dots only). The build number is `ARCLIGHT_VERSION_CODE` when set, else major×10000 + minor×100 + patch (0.23.0 → 2300), the rule `android/app/build.gradle` uses.
  - The script runs after every `npx cap sync` that includes iOS (the `capacitor:sync:after` hook in `apps/player/package.json`), in the store workflow, and from `scripts/bump-version.mjs`. The file is committed with the derived values, so opening the project in Xcode works without running anything. `node apps/player/scripts/ios-version.mjs --check` (run by `player-app-ios.yml`) fails when the file is out of date.
  - For an upload from a Mac, set `ARCLIGHT_VERSION_CODE` to a number above the last upload before `npx cap sync ios`, or App Store Connect rejects the build as a duplicate.
- [ ] **Local network permission:** `NSLocalNetworkUsageDescription` is set ("Arclight connects to your Arclight server on your local network to stream and download your music and audiobooks."). Add `NSBonjourServices` only if LAN discovery is implemented; it is not today. Review will read this text: it must match what the app does.
- [ ] **Camera:** `NSCameraUsageDescription` is set (scanning the pairing QR code). The camera is optional; typing the server address and password also works.
- [ ] **App Transport Security.** `Info.plist` has `NSAllowsLocalNetworking`, `NSAllowsArbitraryLoadsForMedia` and `NSAllowsArbitraryLoadsInWebContent`; `NSAllowsArbitraryLoads` is deliberately not set. That allows plain `http://` to LAN servers (no justification needed), to AVPlayer streams from an HTTP server anywhere, and to the bundled UI's API calls from the WebView. Native downloads (`URLSession`) to a **public** host stay HTTPS-only. The two "arbitrary loads" exceptions **need a justification in App Store Connect**: "Connects to user-hosted media servers whose address the user enters; many run without TLS on the local network." A stricter build could drop them and keep only `NSAllowsLocalNetworking`, which would require HTTPS for every server outside the LAN. Reviewed for 0.24.0 and kept; the app's own cleartext policy decides which hosts get a sign-in (see `apps/player/ios/README.md`).
- [ ] **Privacy manifest** (`apps/player/ios/App/App/PrivacyInfo.xcprivacy`, in the App target's resources). It declares no tracking, no tracking domains and **no collected data types**: the app sends data only to the user's own server, which is not collection by the developer. Required-reason APIs:

  | Category | Reason | Used by |
  | --- | --- | --- |
  | `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` (the app's own data) | `@capacitor/preferences` (settings, account metadata) |
  | `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` (files in the app container) | `DownloadManager.swift` (`attributesOfItem` on finished downloads), `@capacitor/filesystem` (`stat`) |
  | `NSPrivacyAccessedAPICategoryDiskSpace` | `E174.1` (enough space to write), `85F4.1` (shown to the user) | `DownloadManager.swift` (free space before a download, and on the Downloads storage screen) |

  System boot time is not used, so it is not declared. When native code or a plugin starts using another required-reason API, add it here. After archiving, check the aggregated report (Xcode Organizer, the archive, Generate Privacy Report): Capacitor and its plugins may add their own manifests. Missing declarations produce warning emails and can block uploads. `player-app-ios.yml` and the store workflow fail if the file is missing from the built app.
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
  - **2.5.4 Background modes:** only `audio`, used for music and audiobooks that keep playing with the screen locked or another app open.
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
- [ ] Justification for the ATS exceptions entered if App Store Connect asks (section 4; ready-to-paste text in [APP-REVIEW-NOTES.md](APP-REVIEW-NOTES.md)).
- [ ] Release option: **manual release** for the first version, or automatic.
- [ ] Phased release for updates (7-day automatic rollout) considered.
- [ ] Pricing and availability: Free, countries chosen. EU availability needs the DSA trader declaration (section 1).
- [ ] Submitted. Reviews usually take 1 to 3 days; answer any rejection in Resolution Center, change what is asked, resubmit.

## 10. After launch

- [ ] Install from the App Store on a clean iPhone and iPad to confirm.
- [ ] Crash reports (Xcode Organizer / App Store Connect) watched.
- [ ] CarPlay: when Apple grants the entitlement, ship the `CARPLAY_ENABLED=YES` update and re-test in the car.
- [ ] Native iOS video: when it lands, update the screenshots, the description and this page.
- [ ] Each update: build number increased (automatic in CI), "What's New" text, demo server still online, new Apple requirements met (a new SDK minimum each spring).
- [ ] Membership renewed every year; distribution certificates renewed before they expire (cloud-managed signing does this for you); agreements re-accepted when Apple updates them.
