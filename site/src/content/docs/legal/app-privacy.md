---
title: App privacy details
description: A plain table of what the Arclight mobile apps declare for the App Store privacy label and the Google Play Data safety form.
sidebar:
  order: 2
---

Last updated: 31 October 2026

Effective: 31 October 2026

This page mirrors what the Arclight iOS and Android apps declare in the Apple App Store privacy label and the Google Play Data safety form. It matches the [Privacy policy](/legal/privacy/).

## Summary

- **Tracking:** none. The apps do not track you across other apps or websites.
- **Data sold:** none.
- **Data shared for advertising:** none.
- **Third-party SDKs:** no analytics, advertising or crash-reporting SDKs.
- **Account creation in the app:** none. Accounts live on your own server.

## Data the project receives

Only one kind of data reaches the project, and only if you turn on push notifications.

| Data type | Collected by the project? | Linked to your identity? | Used for tracking? | Purpose | Shared? | Encrypted in transit | Can be deleted |
|---|---|---|---|---|---|---|---|
| Device or other ID (push token, plus a random server identifier) | Yes, only if push is enabled | No. No name, email or account is attached. | No | App functionality (delivering notifications) | Only with Apple (APNs) or Google (FCM), to deliver notifications | Yes | Yes. Automatic on unregister, on invalid token and after 90 days unused. Also on request. |
| Notification content | Passes through the relay, not stored | No | No | App functionality | Only with Apple or Google, to deliver | Yes | Not stored after delivery |

## Data the project does not receive

| Data type | Collected by the project? | Notes |
|---|---|---|
| Name, email, phone, address | No | Accounts live on your server. |
| Precise or coarse location | No | |
| Contacts, photos, files | No | |
| Camera images | No | The camera is used only to scan a pairing QR code. Nothing is saved or sent. |
| Biometric data | No | Handled by the operating system. Never available to the app or to us. |
| Browsing or search history | No | |
| Purchases or financial info | No | The app is free. |
| Usage data, diagnostics, crash logs | No | No analytics or crash SDKs. |
| Advertising ID | No | |

## Data stored on your device and sent to your own server

| Data | Where it goes | Collected by the project? |
|---|---|---|
| Server address(es) | Stored on your device | No |
| Sign-in token | iOS Keychain or Android Keystore on your device | No |
| App settings | Stored on your device | No |
| Everything you do in the app | Your own server only | No. The server operator is responsible. |

## Security and deletion

- Data sent to the push relay uses HTTPS.
- To delete data, see [Delete your data](/legal/data-deletion/). That page is also the data deletion URL given to Google Play.

## Questions

Email `privacy@moviemethat.com`.
