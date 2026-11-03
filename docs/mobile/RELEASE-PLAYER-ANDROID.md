# Arclight player for Android and Google TV: Google Play launch checklist

> **Two apps.** This checklist is for the player app **Arclight** (`com.moviemethat.arclight`, `apps/player`). The companion app for running your server, **Arclight Admin** (`com.moviemethat.arclight.admin`, `apps/mobile`), has its own Play listing and its own checklist: [RELEASE-ANDROID.md](RELEASE-ANDROID.md). Several sections here (developer account, privacy policy, testing tracks) are the same work as there; do them once and reuse them.

Everything needed to take the Arclight player from a developer account to one public Google Play listing that serves **phones, tablets, Google TV / Android TV and Android Auto**. Work top to bottom; each section depends on the ones above it. Items marked **(permanent)** cannot be changed after the first upload.

Google changes requirements often. Before each section, check the linked Play Console help page for the current rule.

> **No store CI for the player yet.** `.github/workflows/mobile.yml` builds and uploads **Arclight Admin only**. The player has `.github/workflows/player-app.yml` (typecheck, tests, unsigned debug APK) and `player-app-ios.yml` (iOS simulator build), but nothing that signs a bundle or uploads to Play. Until a player workflow exists, the first releases are built locally (section 3), which also lists the secrets the Admin workflow uses as the pattern to follow.

---

## 0. Decisions to make first

- [ ] **Application ID (permanent).** `com.moviemethat.arclight` (set in `apps/player/android/app/build.gradle` and `capacitor.config.ts`; the Admin app's is this plus `.admin`). It is unique across Google Play forever, cannot be reused after deletion, and should match the iOS bundle ID.
- [ ] **Store name.** "Arclight" (up to 30 characters). Names do not have to be unique on Play, but trademark complaints can remove a listing; search Play for "Arclight" first and keep a fallback ("Arclight Player").
- [ ] **Free, no ads, no in-app purchases** (assumed below).
- [ ] **One listing for all form factors.** Phone, tablet, Google TV and Android Auto share one package and one listing. Each extra form factor adds its own review and its own assets (sections 5 and 6).
- [ ] **Minimum Android version.** The project uses API 26 (Android 8.0) as `minSdkVersion`, with target and compile SDK 36 (`android/variables.gradle`).
- [ ] **Signing choice** (section 2). This is the one decision here that cannot be undone, so make it before the first upload.

### How the app is built

Unlike Arclight Admin, which shows the server's own pages, the player ships its **whole UI inside the app** (Capacitor 8, bundled `dist/`), so it starts and plays downloads with no server in reach. Playback runs in a native Media3 (ExoPlayer) plugin: `PlaybackService` (a `MediaLibraryService`) for background audio, the media notification, headset buttons and the Android Auto browse tree; `VideoActivity` for full-screen movies and TV; WorkManager for background downloads; Google Cast through the Cast framework. The app is a client for the user's own self-hosted server (section 8).

## 1. Developer account

- [ ] Account type confirmed: **personal** or **organization**. This changes the testing requirement in section 9. If the Admin listing already exists, use the same account.
- [ ] Identity verification complete (Play Console, Account details). Organizations also need a D-U-N-S number.
- [ ] Developer name and contact email set. The email and, for organizations, the address are shown publicly on the listing.
- [ ] Two-step verification on the Google account.
- [ ] Android developer verification: Google is rolling out verification for apps installed on certified devices outside Play too. The player's signed APK is also published on GitHub Releases (see `docs/RELEASING.md`, "Android app download"), so register `com.moviemethat.arclight` and its signing key(s) there as well.

## 2. Signing

Two keys are involved, and they are easy to confuse:

- the **app signing key** is what devices check. Every install and update must be signed by the same one, forever;
- the **upload key** only proves to Play that an upload came from you. With Play App Signing, Google verifies the upload key, strips it, and **re-signs the app with the app signing key**.

The project already has a key: the one used for the sideload APK on GitHub Releases. `docs/RELEASING.md` says it is kept offline by the maintainer, never in the repository or CI, and that every APK must use it so installs update in place.

### The choice: do sideloaded APK users have to reinstall?

Android refuses to update an app with a build signed by a different key, so a person who installed the GitHub APK and then installs the Play version (or the reverse) must **uninstall first**, losing local data (downloads and signed-in accounts). Whether that happens depends on what you hand Play:

| Option | App signing key on Play | Same signature as the sideload APK? | Result |
| --- | --- | --- | --- |
| **A. Let Google generate the key** (default) | New key held by Google | No | Cleanest security. Sideload users must uninstall once to move to Play, and again to move back to the APK. |
| **B. Upload the existing APK key as the app signing key** | The existing key, copied to Google | Yes | Play and GitHub builds update each other in place. The key now also lives at Google, and **this can only be chosen when the app is first set up in Play** (it is permanent). |

Using the same keystore only as the **upload key** does *not* help: Google still re-signs with its own key, so the signatures differ. For matching signatures the existing key must be the **app signing key** (option B). You may also reuse that keystore as the upload key, but do not: keep a separate upload key (below), because an upload key can be reset through Play support if it is lost, and the app signing key cannot.

Recommendation: choose B if people already use the sideload APK or you want the GitHub and Play builds to stay interchangeable (the Google TV audience often sideloads); choose A if the sideload APK has no users yet. Either way, say in the release notes of the first Play version which case applies.

- [ ] Option A or B decided and written down.
- [ ] **Play App Signing** enabled (required for new apps).
- [ ] If option B: when creating the app's first release, choose to upload an existing key and export it from the Java keystore with Google's PEPK tool (Play Console shows the exact command). Confirm Play shows the same SHA-256 certificate fingerprint as `keytool -list -v` on the existing keystore.
- [ ] **Upload key** created (a separate keystore, 25+ year validity) and stored safely, with a backup outside the NAS (password manager plus offline copy). Never in the repository.
- [ ] Upload key and app signing key SHA-256 fingerprints recorded (needed for developer verification and any Google API keys).

### Where the app reads signing from

`apps/player/android/app/build.gradle` signs release builds **only when `ANDROID_KEYSTORE_PATH` is set** in the environment, and then reads `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. If `ANDROID_KEYSTORE_PATH` is missing, `assembleRelease` and `bundleRelease` still succeed but produce an **unsigned** artifact that Play rejects. Check that the output is signed (`jarsigner -verify`) before uploading. The comment in `build.gradle` points to `apps/player/README.md` for the secrets, but that README does not document them; this page and `docs/RELEASING.md` do.

## 3. Building a release

- [ ] **Release build is an Android App Bundle (.aab)**; Play no longer accepts APKs for new apps. The existing APK flow in `docs/RELEASING.md` (`assembleRelease`) stays for GitHub Releases.
- [ ] Load the signing variables into the shell (the upload key when building for Play, or the sideload key when building the GitHub APK): `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- [ ] Build with JDK 21 from `apps/player`: `pnpm build && npx cap sync android`, then in `apps/player/android`: `ARCLIGHT_VERSION_CODE=<n> ./gradlew bundleRelease`. The bundle is `app/build/outputs/bundle/release/app-release.aab`.
- [ ] **Version rules.**
  - `versionName` is the repo version (`apps/player/package.json`, set by `scripts/bump-version.mjs`). `versionCode` is `ARCLIGHT_VERSION_CODE` when set (it must be greater than 1), else derived as major×10000 + minor×100 + patch (0.23.0 → 2300). Play requires a higher number on every upload, across all tracks, forever, so pick one scheme and keep it: once you upload a derived code, an override must stay above it.
  - Use a counter that only grows, for example the CI run number or `major * 10000 + minor * 100 + patch`. Pick a scheme once and keep it: a code that has been used can never be reused, even by a deleted release.
  - `versionName` is `1.0.0`, hard-coded in `build.gradle`; raise it by hand for each release and keep it in line with `apps/player/package.json` (the app puts that version in its user agent).
  - With option B in section 2, the GitHub APK and the Play build share a package name and signature, so their version codes must come from the same counter or Android will refuse the "downgrade".
- [ ] Target SDK at the level Play currently requires (the project targets API 36 / Android 16; check "Target API level requirements" in the Play Console help each August).
- [ ] Play Console's pre-launch report and App bundle explorer show no warnings about 64-bit or 16 KB page size support.
- [ ] `minifyEnabled` is `false` in release builds today, which is allowed. If R8 is enabled later, test Cast, Media3 and the Capacitor plugin on a release build first.
- [ ] First .aab uploaded to the **Internal testing** track (section 9) and processed by Play.

### Store CI: what exists and what would be needed

There is **no player store workflow yet**. To add one, copy the `android` job of `.github/workflows/mobile.yml` with `working-directory: apps/player` and package name `com.moviemethat.arclight`. That workflow uses these repository secrets, and a player workflow would use the same names (or player-specific ones if its upload key differs):

| Secret | Used for |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The upload keystore, base64 encoded; written to a temp file whose path becomes `ANDROID_KEYSTORE_PATH` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | Play Console API service account, used by `r0adkll/upload-google-play` to upload to the internal track |
| `GOOGLE_SERVICES_JSON` | Optional `google-services.json` for push; the player does not use push, so it is not needed |

The workflow also passes `ARCLIGHT_VERSION_CODE` as the run number when uploading, and deletes the keystore at the end. The iOS job uses `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY_P8` and `APPLE_TEAM_ID` (see [RELEASE-PLAYER-IOS.md](RELEASE-PLAYER-IOS.md)). Never put the offline sideload key into CI. With option B, a CI-held upload key that differs from the offline app signing key is the safe split.

- [ ] Decision: build bundles locally for now, or add the player workflow first. If CI is added, the first upload of a brand-new app still has to be done by hand or with `status: draft`; the Play API cannot publish an app that has never been published.

## 4. Permissions and manifest review

This is what the manifest declares today (`apps/player/android/app/src/main/AndroidManifest.xml`). Review it against the Play policies in section 8.

- [ ] Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK`, `POST_NOTIFICATIONS` (Android 13+, asked at runtime). No storage, location, contacts or microphone permissions. The camera is for scanning the pairing QR code and is optional (`uses-feature camera required="false"`; the barcode plugin asks at runtime).
- [ ] **Cleartext traffic.** `usesCleartextTraffic="true"` plus `network_security_config.xml` allow plain `http://` to any host, and `capacitor.config.ts` sets `allowMixedContent: true`. This is deliberate: self-hosted servers are often `http://` on a home network and the address is typed by the user. Only system certificate authorities are trusted. The app enforces its own rule on top (`src/core/transport.ts`): it tries HTTPS first, shows a notice for plain HTTP on the home network, and sends no sign-in or token over plain HTTP to an internet host until the user types that host's name. See the Security section of `apps/player/README.md`. Be ready to explain it to a reviewer: "connects to the user's own server at an address they enter; the app tries HTTPS first and asks the user to confirm before using plain HTTP outside a private network".
- [ ] Backups: `allowBackup="false"` (tokens and downloads must not move to another device).
- [ ] FileProvider: `res/xml/file_paths.xml` shares only the app's `files/Pictures/` folder (WebView camera captures).
- [ ] Services: `PlaybackService` has `foregroundServiceType="mediaPlayback"` and is exported (media controllers and Android Auto bind to it; `car/ControllerPolicy.java` turns away apps that are not the system, Bluetooth, a trusted controller or a genuine Android Auto host); WorkManager's `SystemForegroundService` is merged in with `dataSync` for downloads (section 8).
- [ ] The pairing link `arclight://pair?server=...&code=...` is a browsable intent filter on `MainActivity`; it only starts a sign-in the user must confirm.
- [ ] No ads, analytics or crash-reporting SDKs. (If one is added, declare it in the data safety form.)
- [ ] Licenses screen lists open-source dependencies (GPL-3.0 app; include the source link).

## 5. Google TV and Android TV

TV support is part of this same package, but Play treats it as a separate form factor with a separate review.

### Opt in

- [ ] Play Console, **Release > Setup > Advanced settings > Form factors**: add **Android TV** (Google TV / Android TV). Adding it triggers a **separate TV review** the next time a release is sent for review, and TV store assets become mandatory.
- [ ] Decide when. You can ship phone and tablet first and add TV in a later release, but the TV review then starts at that point. Do not opt in until the quality checks below pass on a real TV or the emulator.

### Quality requirements checked against the app

Google's Android TV app quality checklist is the review. Today the app has:

| Requirement | State in the app |
| --- | --- |
| Leanback launcher intent | `MainActivity` has `android.intent.category.LEANBACK_LAUNCHER`, next to the normal `LAUNCHER` filter |
| Home screen banner | `android:banner="@drawable/tv_banner"` on `<application>`; 320 x 180 px (xhdpi, generated by `scripts/generate-assets.mjs`) |
| Touchscreen not required | `uses-feature android.hardware.touchscreen required="false"`; `faketouch`, `leanback`, camera, microphone, telephony, GPS and portrait screen are also `required="false"` |
| No portrait lock | `MainActivity` sets no `screenOrientation`; `VideoActivity` is `sensorLandscape`, which is fine on TV |
| D-pad navigation | The WebView takes focus at start-up; arrows reach the UI as arrow keys, OK as Enter, Back goes to the app's back handler; the video player scrubs with left/right, shows controls with up/down, and OK plays or pauses |
| Picture-in-picture | Phones only; the activity checks and TVs keep it off |

- [ ] **Walk the whole app with a D-pad only** (Android TV emulator, API 34 or later, `adb install -r`, plus a real Google TV device if possible): onboarding, library browse, now playing, queue, downloads, settings, the video player, every dialog and menu. No screen may trap focus or need a tap.
- [ ] **Sign-in works without a camera.** QR scanning is unavailable on TV, so typing the server address and a password (or entering the 8-character pairing code) must be reachable and usable with a remote.
- [ ] Focus is always visible and starts somewhere sensible on every screen.
- [ ] Text is readable at 10 feet; layouts keep the overscan-safe margin; no scroll traps.
- [ ] Back and Home behave as on other TV apps (Back leaves the screen, never the app by accident from the middle of a flow).
- [ ] Playback survives the screensaver; the media session shows on the system "now playing" UI.
- [ ] No phone-only wording left on TV ("tap", "swipe", "scan with your camera").

### TV assets

- [ ] **TV screenshots:** at least 1 (up to 8), **1920 x 1080** (16:9) PNG or JPEG, taken on a TV or the emulator with the demo server's sample library. No device frames.
- [ ] **TV banner graphic** in the store listing: **1280 x 720** PNG or JPEG, no transparency, and no text beyond the app's logo and name. This is separate from the 320 x 180 launcher banner inside the app.

### Common TV rejection reasons

- Missing `LEANBACK_LAUNCHER` filter or banner, or a banner that is not 320 x 180.
- `touchscreen` or a camera, microphone or telephony feature left as required, so TVs cannot see the app at all.
- Parts of the app unusable with a D-pad (focus trapped in the QR scanner, a dialog, or the video controls).
- Portrait-only or phone-only screens shown on the TV.
- Crash or blank screen on first launch without a server (the player is meant to start without one; verify).
- TV screenshots that are phone screenshots, have device frames, or are the wrong size.
- Sign-in that cannot be completed on TV with the reviewer credentials (give the typed-address route in "App access", section 8).

## 6. Android Auto

Arclight is an Android Auto **media app**: `PlaybackService` is a `MediaLibraryService` that also answers `android.media.browse.MediaBrowserService`, and the manifest has the `com.google.android.gms.car.application` meta-data pointing to `res/xml/automotive_app_desc.xml` (`<uses name="media" />`). The car shows a browse tree and playback controls; there is no custom car UI.

- [ ] Play Console, **Release > Setup > Advanced settings > Form factors**: add **Android Auto** (media app). This adds a media app review for cars to the normal review.
- [ ] Quality checked against Google's Android Auto media app guidelines, tested with the **Desktop Head Unit (DHU)** and a real car or head unit if possible:
  - [ ] The app appears in the Android Auto launcher and the browse tree loads from the signed-in account's server.
  - [ ] Playback starts from the browse tree; next, previous and seek work; title, artist and artwork show; voice "play ... on Arclight" works as far as the media session supports it.
  - [ ] When signed out or the server is unreachable, the car shows a clear message instead of an empty list.
  - [ ] **Driving safety:** the car offers audio only. Video never appears on the car screen.
  - [ ] Artwork loads through `ArtworkProvider` (`${applicationId}.artwork`, not exported).
- [ ] Expect an extra day or more for this review and possible questions about driver distraction. Reviewers need to sign in on the demo server (section 8).
- [ ] Optional: a 16:9 car screenshot in the listing (the system draws the UI, so none is required).

## 7. Store listing assets

- [ ] App name: Arclight
- [ ] Short description (80 characters), for example: "Your music, audiobooks, movies and TV from your own Arclight server."
- [ ] Full description (4,000 characters). Describe it as a client for the user's own self-hosted server, and spell out phone, tablet, Google TV, Android Auto, offline downloads and Cast. Do not mention piracy, torrent sites or copyrighted titles; screenshots and text show only legal sample content. State plainly that **a server is required**.
- [ ] App icon: 512 x 512 PNG, 32-bit, under 1 MB (**waiting on the new logo**).
- [ ] Feature graphic: 1024 x 500 PNG or JPEG, no transparency.
- [ ] **Phone screenshots:** 2 to 8, 16:9 or 9:16, at least 1080 px on the short side for featuring. Use the demo server's sample library.
- [ ] **Tablet screenshots:** 7" and 10", up to 8 each.
- [ ] **TV screenshots and banner graphic:** see section 5.
- [ ] Optional promo video (YouTube URL).
- [ ] Category: Music & Audio, or Video Players & Editors if video is the main draw; one primary category. Tags chosen.
- [ ] Contact email support@moviemethat.com, website https://arclight.moviemethat.com, privacy policy https://arclight.moviemethat.com/legal/privacy/
- [ ] Translations of the listing (optional; the app itself ships English, German, Spanish, French and Dutch).

## 8. Policy and app content (Play Console, Policy and programs > App content)

- [ ] Privacy policy URL entered: https://arclight.moviemethat.com/legal/privacy/ (data safety summary: https://arclight.moviemethat.com/legal/app-privacy/). **Check those pages cover the player app**: what it stores (server address, device token, download index) and where it goes (only the user's own server).
- [ ] Ads: "No, my app does not contain ads".
- [ ] **Target audience:** 18+ (avoids the Families policy). Not designed for children.
- [ ] **Content rating questionnaire (IARC).** Category: Music & Audio / Video Players, or Utility. The app plays whatever is on the user's server, so answer the user-generated and unrestricted-content questions honestly and expect a mature rating. Screenshots show legal sample content only.
- [ ] **Data safety** form:
  - data collected by the developer: **none**. No analytics, ads or crash SDK, and the app talks **only to the user's own server** (plus the Cast receiver the user picks);
  - data shared: none; no tracking;
  - credentials and listening progress sent to the user's own server are not collected by you (there is no developer-run backend);
  - encryption in transit: yes where the server uses HTTPS. Self-hosted servers may use plain HTTP on a home network; say so if the form allows a note;
  - deletion: signing out removes the token; users delete downloads and accounts in Settings; uninstalling removes everything. Data deletion URL: https://arclight.moviemethat.com/legal/data-deletion/
- [ ] **Account deletion:** the app creates no accounts (they live on the user's server). Declare that.
- [ ] Government app, financial features, health, news: all "No".
- [ ] **Foreground service permission declarations** (App content > Foreground service permissions). The manifest uses two types, and Play asks about each:
  - **`mediaPlayback`** (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `PlaybackService`): keeps audio and video playing with the screen off or the app in the background, with a media notification the user can stop. Core feature.
  - **`dataSync`** (`FOREGROUND_SERVICE_DATA_SYNC`, WorkManager's `SystemForegroundService`): user-started offline downloads that keep running when the app closes, with a visible progress notification. Android 15 limits `dataSync` to about 6 hours in 24, so the download worker must stop and resume cleanly. If Google asks for a different type, user-initiated data transfer jobs are the alternative.
  - For each, Play asks for a **short video** (unlisted YouTube or a file link) showing the user action that starts the service and the visible result. Record on a real phone:
    1. `mediaPlayback`: open the app, start a track or video, press Home, show the media notification and lock-screen controls, pause and stop from the notification.
    2. `dataSync`: tap Download on an album or movie, show the progress notification, leave the app, come back and play the item offline in airplane mode.
  - Show any runtime prompts (such as notifications) as they actually appear.
- [ ] **Google Cast SDK.** The app uses the Cast framework with Google's **Default Media Receiver** (`CastOptionsProvider`), so no Cast Developer Console registration or custom receiver is needed. It is optional at runtime and ignored when Play services are missing. Answer any Cast-related data questions per Google's Cast guidance; it does not make you a data collector.
- [ ] No sensitive permissions (SMS, call log, accessibility, all-files access, exact alarms), no VPN service, no `REQUEST_INSTALL_PACKAGES`.
- [ ] **App access:** "All or some functionality is restricted", with the instructions below.

### Reviewers need a server

The player is a client for a self-hosted server. Reviewers cannot use it without one, and "app doesn't work" or "login required" is a common rejection.

- [ ] **Demo server** online at a stable HTTPS address (this page uses `https://demo.example.com`; use your own domain), separate from any personal server:
  - a sample library of public-domain or self-made content only (music, an audiobook, a short film), so every feature in the screenshots works;
  - no indexers and no download clients configured;
  - the player app enabled for the reviewer account (the server admin controls who may use it);
  - a **reviewer account**, and optionally a **pairing code** that does not expire during review;
  - kept online for every review, including updates.
- [ ] **App access** text, for example: "Arclight is a client for a self-hosted media server and needs one to show content. Demo server: https://demo.example.com. Username: reviewer. Password: (the one you set). On first launch tap Add server, enter the address above, then sign in with the account. On Google TV, type the address with the on-screen keyboard; no camera is needed. The demo server contains only public-domain sample media."
- [ ] The listing description repeats that a server is required, so users do not rate the app down for not finding one.
- [ ] Credentials tested on a clean phone, a TV emulator and the Android Auto DHU, using the Internal-test build, before each submission.

## 9. Testing tracks

- [ ] **Internal testing** track: upload the .aab, add yourself and a few testers by email, install from the opt-in link. Test: add a server (HTTP and HTTPS), password and pairing-code sign-in, audio and video playback, background playback, downloads and offline play, Cast, the TV layout, Android Auto in the DHU, rotation, tablet layout.
- [ ] Pre-launch report reviewed (Play runs the app on test devices; fix crashes and accessibility warnings; the robot cannot sign in, which is expected).
- [ ] **Closed testing**, required for **personal** accounts created after November 2023: at least **12 testers opted in for 14 days in a row**, then apply for production access and answer Google's questions about the test. Organization accounts can skip this. If Arclight Admin has already passed this on the same account, ask Play whether the existing production access covers the new app; otherwise run both tests together.
  - [ ] Tester list (Google group or emails) ready; 15 or more people to keep 12 opted in. Include at least one person with a Google TV or Android TV device.
  - [ ] Feedback collected and fixes shipped during the 14 days (Google asks about this).
- [ ] Production access granted.

## 10. Production release

- [ ] Countries and regions chosen (all, or a list).
- [ ] Release notes written ("What's new").
- [ ] Form factors confirmed (phone, tablet, Android TV, Android Auto), with each one's assets and policy items done.
- [ ] Production release created from the tested build, **staged rollout** (for example 20%, then 50%, then 100%).
- [ ] Sent for review. First reviews take from a few days to over a week, and the TV and Auto reviews can add time.
- [ ] After approval: install from Play on a clean phone and a TV, and confirm the listing shows the TV and Android Auto badges.
- [ ] Short links `/android` and `/tv` (`site/public/_redirects`) and the "Android app download" section of `docs/RELEASING.md` updated to point at Play, keeping the GitHub APK as the alternative. Tell sideload users how to switch (section 2).

## 11. After launch

- [ ] Android vitals watched (crash rate, ANR rate, excessive wake locks and background work from downloads).
- [ ] Each update: version code increased (`ARCLIGHT_VERSION_CODE`), version name raised, release notes, same staged rollout, demo server still online.
- [ ] Target SDK raised every year before Google's August deadline; foreground service rules re-read with each Android release.
- [ ] Reviews answered; policy emails from Google handled within their deadlines.
- [ ] Upload key backup (and, with option B, the app signing key backup) checked once a year.
