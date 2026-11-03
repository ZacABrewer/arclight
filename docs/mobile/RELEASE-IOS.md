# Arclight Admin for iOS: App Store launch checklist

> **Two apps.** This checklist is for **Arclight Admin** (`com.moviemethat.arclight.admin`, `apps/mobile`), the companion app for running your server. The player app **Arclight** (`com.moviemethat.arclight`, `apps/player`) is a separate app with its own App Store record; its checklist is still to come.

Everything needed to take the Arclight Admin iPhone (and optionally iPad) app from an Apple Developer Program membership to a public App Store listing. Work top to bottom. Items marked **(permanent)** cannot be changed after the first upload.

Apple changes requirements every year, usually around WWDC and in the spring. Check App Store Connect Help and the App Review Guidelines before each section.

---

## 0. Decisions to make first

- [ ] **Bundle ID (permanent).** Used by the app: `com.moviemethat.arclight.admin` (`com.moviemethat.arclight` is the player app's). Use the same ID as the Android application ID. Pairing links use the app's own URL scheme, `arclight-admin://pair?url=...`.
- [ ] **App Store name.** "Arclight Admin" (up to 30 characters; "Arclight" alone is reserved for the player app). Names are **unique across the App Store**; reserve it early by creating the app record (section 3). Have a fallback ready, for example "Arclight Server Admin" or "Arclight – Server Remote".
- [ ] **Subtitle** (30 characters), for example "Your self-hosted media server".
- [ ] **Free, no in-app purchases** (assumed below; paid apps need the Paid Apps agreement, tax and banking).
- [ ] **Minimum iOS version.** iOS 16 or newer is a sensible floor.
- [ ] **iPhone only, or iPhone and iPad.** iPad support needs iPad screenshots and an iPad-friendly layout.
- [ ] **Push notification route** (see section 5).

### How the app is built

Arclight Admin is a **companion app**, like the Home Assistant and Jellyfin apps: a native shell (Capacitor, in `apps/mobile`) handles server setup, Keychain sign-in, push notifications, Face ID lock and the share sheet, and shows the Arclight interface served by the user's own server. Admins see the admin portal and other users the request portal, as on the web, and new server features appear without an app update. Those native features are also what keeps the app clear of guideline 4.2 (a plain website in a frame is rejected).

## 1. Membership and agreements

- [ ] Apple Developer Program membership active (renews yearly; the app is removed from sale if it lapses).
- [ ] App Store Connect → Business: **Free Apps agreement** accepted (and any updated Program License Agreement; new versions block uploads until accepted).
- [ ] **EU Digital Services Act trader status** declared (App Store Connect → Business). If you are a "trader", your address, phone and email are shown publicly on the EU listing. A free, non-commercial hobby project can usually declare non-trader; read Apple's guidance and decide before submitting, or EU availability is blocked.
- [ ] Two-factor authentication on the Apple Account.

## 2. Building without a Mac

iOS apps must be built and signed with Xcode on macOS.

- [ ] Build route chosen:
  - **GitHub Actions macOS runners:** free for public repositories; build, sign and upload to App Store Connect with fastlane, using an App Store Connect API key stored as encrypted secrets. Works from Windows.
  - Or a Mac (or a cloud Mac rental) with Xcode, or a hosted service such as Codemagic.
- [ ] Builds use the Xcode and iOS SDK version Apple currently requires for uploads (Xcode 26 / iOS 26 SDK as of 2026; check "Upcoming requirements" in the developer news).

## 3. Identifiers, certificates and the app record

- [ ] **App ID** registered (Certificates, Identifiers & Profiles → Identifiers) with the bundle ID. Capabilities: Push Notifications (if used). Nothing else expected.
- [ ] **App Store Connect API key** (Users and Access → Integrations) for CI uploads; Issuer ID, Key ID and the .p8 stored as GitHub secrets.
- [ ] Distribution certificate and App Store provisioning profile (fastlane match or manual); the certificate's .p12 backed up.
- [ ] **APNs key** (.p8) created if push is used (Keys → Apple Push Notifications service). Record the Key ID and Team ID. Store the key only in the push relay; never commit it. One key covers both apps; the relay picks the topic (bundle ID) per device from its `APNS_TOPICS` allow-list.
- [ ] **App Store Connect app record** created: platform iOS, name, primary language, bundle ID, SKU (any internal string, for example `arclight-admin-ios`), full access. This reserves the name.

## 4. Project setup

- [ ] App project in the repository (`apps/mobile`, Capacitor, shared with Android).
- [ ] Version (`1.0.0`) and build number (`1`, increased on every upload).
- [ ] **App Transport Security**: Arclight servers are often plain `http://` on a home network. Prefer `NSAllowsLocalNetworking` (allows HTTP to local addresses only) over `NSAllowsArbitraryLoads`; if arbitrary loads are needed for HTTP servers reached by hostname, be ready to justify it to App Review ("connects to the user's own self-hosted server").
- [ ] **Local network permission**: `NSLocalNetworkUsageDescription` text, for example "Arclight Admin connects to your Arclight server on your home network." Add `NSBonjourServices` only if server discovery on the LAN is implemented.
- [ ] Camera usage text (`NSCameraUsageDescription`) only if QR pairing is implemented.
- [ ] **Privacy manifest** (`PrivacyInfo.xcprivacy`): declares no tracking, no collected data types (or the push token, see section 7), and the required-reason APIs used by the app and its SDKs (Capacitor and its plugins ship their own manifests; check the build's aggregated report).
- [ ] **Export compliance**: the app only uses standard HTTPS, so set `ITSAppUsesNonExemptEncryption` to `false` in Info.plist (skips the question on every upload).
- [ ] No ads, analytics or tracking SDKs, so no App Tracking Transparency prompt is needed.
- [ ] Sign-in tokens stored in the Keychain, not plain storage.
- [ ] Licenses screen (GPL-3.0; link to the source).

## 5. Push notifications

Arclight is self-hosted, so each server must reach the user's phone without holding your APNs key.

- [ ] Route decided:
  - **Relay (recommended):** servers send to a small push relay you run (for example a Cloudflare Worker) that holds the APNs key.
  - **Direct APNs:** every server would need your .p8 key. Not suitable for a public self-hosted project.
- [ ] Permission asked at a sensible moment (after sign-in, with an explanation), not on first launch.
- [ ] Tested on a real iPhone via TestFlight: foreground, background, app closed.

## 6. Things App Review needs

App Review must be able to use the app without your home network.

- [ ] **Demo server** online at a stable HTTPS address, separate from any personal server:
  - sample library of public-domain or self-made content only;
  - no indexers and no download clients configured;
  - a **reviewer account** (requester) and, if admin screens are in the app, an admin account;
  - online for every review, including every update.
- [ ] **Privacy policy URL**: https://arclight.moviemethat.com/legal/privacy/ (privacy label summary: https://arclight.moviemethat.com/legal/app-privacy/). Check it still matches the app: what the app stores (server address, sign-in token, push token), where it goes (only the user's server, and the push relay for the token), no tracking, contact.
- [ ] **Support URL**: https://arclight.moviemethat.com/support/; marketing URL: https://arclight.moviemethat.com/; terms: https://arclight.moviemethat.com/legal/terms/
- [ ] Guidelines checked against the app:
  - **4.2 Minimum functionality:** native screens, not a wrapped website.
  - **5.2.3 Audio/video downloading:** the app must not help download media from third-party sources. Present it as a remote control for the user's own server; reviewer-visible content is legal sample media only; no indexer search in the reviewer's path.
  - **5.1.1 Data collection:** no sign-up in the app (accounts live on the user's server), so no in-app account deletion is required. If sign-up is ever added, account deletion must be added too.
  - **TMDB attribution:** if posters or metadata from TMDB are shown, the TMDB logo and notice appear (for example in About).

## 7. App Store Connect: App information and privacy

- [ ] Category: primary **Utilities** (or Entertainment), secondary optional.
- [ ] **Age rating** questionnaire answered (Apple's updated ratings: 4+, 9+, 13+, 16+, 18+). The app shows whatever the user's server contains, so answer the questions on unrestricted web content / user content honestly; 16+ or 18+ is likely.
- [ ] Content rights: "Does your app contain, show or access third-party content?" Yes (metadata and artwork from the user's server and TMDB); confirm you have the rights or the content is the user's own.
- [ ] **App Privacy** ("nutrition label"):
  - data used to track you: none;
  - data linked to you: none collected by the developer;
  - if the push relay receives device tokens: "Identifiers → Device ID", app functionality, not linked to identity, not used for tracking.
- [ ] Privacy policy URL entered.

## 8. Version page and media

- [ ] **Screenshots**: iPhone 6.9" set (1320 × 2868 or 1290 × 2796 portrait), 1 to 10 images; Apple scales them down for smaller iPhones. iPad 13" set (2064 × 2752) if iPad is supported. Use the demo server's sample library.
- [ ] App preview video (optional).
- [ ] Promotional text (170 characters, editable without review).
- [ ] Description (4,000 characters): remote control for your own Arclight server; no mention of piracy or copyrighted titles.
- [ ] Keywords (100 characters, comma-separated, no spaces after commas; do not repeat the app name or use competitors' names).
- [ ] Support URL, marketing URL, copyright line ("2026 Arclight contributors").
- [ ] App icon: 1024 × 1024 PNG, no transparency, no rounded corners (iOS rounds it) (**waiting on the new logo**). iOS 18+ also supports dark and tinted icon variants; provide them for a polished look.

## 9. TestFlight

- [ ] First build uploaded (fastlane from GitHub Actions, or Xcode Organizer) and processed.
- [ ] Export compliance answered (skipped if set in Info.plist).
- [ ] **Internal testing**: up to 100 people in your App Store Connect team; no review needed. Test sign-in, requests, notifications, HTTP and HTTPS servers, local network prompt, server switching.
- [ ] **External testing** (optional, up to 10,000 testers via email or public link): needs Beta App Review; fill in test information and the demo account.
- [ ] Crashes and feedback from TestFlight fixed.

## 10. Submit for review

- [ ] Build selected on the 1.0 version page.
- [ ] **App Review Information**: sign-in required → demo username and password; notes, for example: "Arclight Admin is a client for a self-hosted media server. On first launch tap Add server and enter https://… then sign in with the account above. The demo server contains public-domain sample media."; contact name, phone and email (not shown publicly).
- [ ] Release option: **manual release** for the first version (release after approval when you are ready), or automatic.
- [ ] Phased release for updates (7-day automatic rollout) considered.
- [ ] Pricing and availability: Free, countries chosen. EU availability needs the DSA trader declaration (section 1).
- [ ] Submitted. Reviews usually take 1–3 days; answer any rejection in Resolution Center, change what is asked, resubmit.

## 11. After launch

- [ ] Install from the App Store on a clean device to confirm.
- [ ] Crash reports (Xcode Organizer / App Store Connect) watched.
- [ ] Each update: build number increased, "What's New" text, demo server still online, new Apple requirements met (new SDK minimum each spring).
- [ ] Membership renewed every year; certificates and the APNs key renewed before they expire (distribution certificates last a year; the APNs .p8 key does not expire but can be revoked).
- [ ] Agreements re-accepted when Apple updates them (uploads are blocked until you do).
