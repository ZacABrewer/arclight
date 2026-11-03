# Arclight Admin for Android: Google Play launch checklist

> **Two apps.** This checklist is for **Arclight Admin** (`com.moviemethat.arclight.admin`, `apps/mobile`), the companion app for running your server. The player app **Arclight** (`com.moviemethat.arclight`, `apps/player`) is a separate app with its own Play listing; its checklist is [RELEASE-PLAYER-ANDROID.md](RELEASE-PLAYER-ANDROID.md).

Everything needed to take the Arclight Admin Android app from a developer account to a public listing on Google Play. Work top to bottom; each section depends on the ones above it. Items marked **(permanent)** cannot be changed after the first upload.

Google changes requirements often. Before each section, check the linked Play Console help page for the current rule.

---

## 0. Decisions to make first

- [ ] **Application ID (permanent).** Used by the app: `com.moviemethat.arclight.admin` (reverse of the project domain, plus `.admin`; `com.moviemethat.arclight` is the player app's). It is unique across Google Play forever, cannot be reused after deletion, and must match the iOS bundle ID if you want one ID everywhere. Use a domain you control.
- [ ] **Store name.** "Arclight Admin" (up to 30 characters; "Arclight" alone is the player app). Names do not have to be unique on Play, but trademark complaints can remove a listing; search Play for "Arclight" first and keep a fallback ("Arclight Server Admin").
- [ ] **Free, no ads, no in-app purchases** (assumed below; paid apps need a payments profile and tax setup).
- [ ] **Minimum Android version.** Android 8.0 (API 26) or newer is a sensible floor.
- [ ] **Phone only, or phone and tablet.** Tablets need their own screenshots.
- [ ] **Push notification route** (see section 4).

### How the app is built

Arclight Admin is a **companion app**, like the Home Assistant and Jellyfin apps: a native shell (Capacitor, in `apps/mobile`) handles server setup, secure sign-in, push notifications, biometric lock and the share sheet, and shows the Arclight interface served by the user's own server. Admins therefore see the admin portal and other users the request portal, exactly as on the web, and new server features appear without an app update. Only changes to the native shell need a new release.

## 1. Developer account

- [ ] Account type confirmed: **personal** or **organization**. This changes the testing requirement in section 8.
- [ ] Identity verification complete (Play Console → Account details). Organizations also need a D-U-N-S number.
- [ ] Developer name and contact email set. The email and, for organizations, the address are shown publicly on the listing.
- [ ] Two-step verification on the Google account.
- [ ] Android developer verification: Google is rolling out verification for apps installed on certified devices outside Play as well. If you will also offer an APK on GitHub, register the app's package name and signing key there too.

## 2. Project setup

- [ ] App project created in the repository (`apps/mobile`, Capacitor). Built by GitHub Actions (free for public repositories) or locally with Android Studio.
- [ ] `applicationId`, version name (`1.0.0`) and version code (`1`, increased on every upload) set.
- [ ] Target SDK at the level Play currently requires for new apps (API 36 / Android 16 from August 2026). Check "Target API level requirements" in the Play Console help.
- [ ] Release build is an **Android App Bundle (.aab)**; Play no longer accepts APKs for new apps.
- [ ] Network security config: Arclight servers are often plain `http://` on a home network. Allow cleartext traffic only as needed (for example private address ranges), keep HTTPS the default, and explain it in the app's server screen.
- [ ] Permissions reviewed: only what is used. Expected: `INTERNET`, `POST_NOTIFICATIONS` (Android 13+, asked at runtime), optionally `CAMERA` for scanning a pairing QR code. No storage, location or contacts permissions.
- [ ] No ads SDKs, no analytics SDKs (keeps the data safety form simple). If crash reporting is added, it must be declared in section 6.
- [ ] Licenses screen lists open-source dependencies (GPL-3.0 app; include the source link).

## 3. Signing

- [ ] **Play App Signing** enabled (default for new apps): Google holds the app signing key.
- [ ] **Upload key** created and stored safely, with a backup outside the NAS (password manager plus offline copy). For CI builds, store it as encrypted GitHub Actions secrets (keystore as base64, passwords), never in the repository.
- [ ] Upload key fingerprint recorded (needed for Firebase if push uses FCM).

## 4. Push notifications

Arclight is self-hosted, so each user's server must be able to reach their phone without holding your Firebase secrets.

- [ ] Route decided:
  - **Relay (recommended):** servers send to a small push relay you run (for example a Cloudflare Worker), which holds the FCM credentials. Nothing secret ships inside Arclight.
  - **Direct FCM:** every server would need your service account key. Not suitable for a public self-hosted project.
- [ ] Firebase project created; Android app registered with the application ID; `google-services.json` added to the build.
- [ ] FCM HTTP v1 service account key created and stored only in the relay; never committed to the repository.
- [ ] Notification channels defined (Requests, Downloads, Health) so users can mute them separately.
- [ ] Tested on a real device: app in foreground, background and killed.

## 5. Things Google reviewers need

- [ ] **Demo server** online at a stable HTTPS address, separate from any personal server:
  - sample library of public-domain or self-made content only;
  - no indexers and no download clients configured;
  - a **reviewer account** with requester permissions (and one admin account if admin screens are in the app);
  - kept online for every review, including updates.
- [ ] **Privacy policy**: https://arclight.moviemethat.com/legal/privacy/ (data safety summary: https://arclight.moviemethat.com/legal/app-privacy/). Check it still matches the app: what the app stores (server address, sign-in token, push token), where it goes (only the user's own server, and the push relay for the token), no tracking, no selling, contact address.
- [ ] Support: https://arclight.moviemethat.com/support/ (support@moviemethat.com). Data deletion URL for the Data safety form: https://arclight.moviemethat.com/legal/data-deletion/

## 6. App content (Play Console → Policy → App content)

- [ ] Privacy policy URL entered.
- [ ] Ads: "No, my app does not contain ads".
- [ ] **App access**: "All or some functionality is restricted" → add instructions with the demo server address, reviewer username and password, and steps ("Tap Add server, enter …, sign in").
- [ ] Content rating questionnaire (IARC) completed. Category: Utility / Productivity. Answer truthfully; posters and titles come from the user's own server and TMDB.
- [ ] Target audience: 18+ (avoids the Families policy).
- [ ] **Data safety** form:
  - data collected: none by the developer;
  - data shared: none;
  - data the app sends to the user's own server is not "collected" by you, but list the push token if the relay receives it (device ID, for app functionality, not shared, encrypted in transit);
  - encryption in transit: yes (HTTPS; note that self-hosted servers may use HTTP on a home network);
  - deletion: users can remove the server and sign out in the app, which deletes all stored data.
- [ ] Account deletion: the app does not create accounts (accounts live on the user's server). Declare that; no deletion URL is needed unless the app gains sign-up.
- [ ] Government app, financial features, health, news: all "No".
- [ ] Foreground service and special permissions declarations: only if used (not expected).

## 7. Store listing

- [ ] App name: Arclight Admin
- [ ] Short description (80 characters), for example: "Manage your self-hosted Arclight server: requests, library and downloads."
- [ ] Full description (4,000 characters). Describe it as a remote control for the user's own server. Do not mention piracy, torrent sites or copyrighted titles; screenshots and text show only legal sample content.
- [ ] App icon: 512 × 512 PNG, 32-bit, under 1 MB (**waiting on the new logo**).
- [ ] Feature graphic: 1024 × 500 PNG or JPEG, no transparency.
- [ ] Phone screenshots: 2 to 8, 16:9 or 9:16, at least 1080 px on the short side for featuring. Use the demo server's sample library.
- [ ] Tablet screenshots (7" and 10") if tablets are supported.
- [ ] Category: Tools or Productivity. Tags chosen.
- [ ] Contact email support@moviemethat.com, website https://arclight.moviemethat.com, privacy policy URL https://arclight.moviemethat.com/legal/privacy/
- [ ] Translations of the listing (optional; Play can machine-translate).

## 8. Testing before production

- [ ] **Internal testing** track: upload the first .aab, add yourself and a few testers by email, install from the opt-in link, test sign-in, requests, notifications and server switching.
- [ ] Pre-launch report reviewed (Play runs the app on test devices; fix crashes and accessibility warnings).
- [ ] **Closed testing**, required for personal accounts created after November 2023: at least **12 testers opted in for 14 days in a row**, then apply for production access and answer Google's questions about the test. Organization accounts can skip this.
  - [ ] Tester list (Google group or emails) ready; 15 or more people to keep 12 opted in.
  - [ ] Feedback collected and fixes shipped during the 14 days (Google asks about this).
- [ ] Production access granted.

## 9. Production release

- [ ] Countries and regions chosen (all, or a list).
- [ ] Release notes written ("What's new").
- [ ] Production release created from the tested build, **staged rollout** (for example 20%, then 50%, then 100%).
- [ ] Sent for review. First reviews take from a few days to over a week.
- [ ] After approval: the listing is live; install from Play on a clean device to confirm.

## 10. After launch

- [ ] Android vitals watched (crash rate, ANR rate).
- [ ] Each update: version code increased, release notes, same staged rollout, demo server still online.
- [ ] Target SDK raised every year before Google's August deadline.
- [ ] Reviews answered; policy emails from Google handled within their deadlines.
- [ ] Upload key backup checked once a year.
