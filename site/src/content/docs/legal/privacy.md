---
title: Privacy policy
description: What data the Arclight website, mobile apps and push relay handle, and what they never collect.
sidebar:
  order: 1
---

Last updated: 31 October 2026

Effective: 31 October 2026

## Summary

- The Arclight project receives **no data from your server**. There is no telemetry, no analytics and no project account.
- **No tracking.** No ads, no advertising IDs, no third-party analytics or crash-reporting SDKs.
- **No selling or sharing** of personal information, for advertising or anything else.
- The website sets **no cookies** and loads no third-party scripts or fonts.
- The mobile apps talk **only to the server you enter**. The one exception is optional push notifications, which use a small relay run by the project (see below).

## Who we are

"We" and "the Arclight project" mean the maintainers of Arclight, a free, open-source (GPL-3.0), self-hosted media manager. We are the data controller for the website and the push relay described on this page. We have no company and we do not publish a postal address. Contact us by email (see [Contact](#contact)).

## Self-hosted software and your server

Arclight is software you run on your own hardware. The person who runs a server (the "server operator") controls all data on it: user accounts, requests, the library, logs and settings. The operator is responsible for that data, not the Arclight project.

- The project never receives data from anyone's server.
- A server contacts only services its operator configures, such as TMDB, MusicBrainz, Open Library, subtitle providers, indexers, download clients, media servers and notification services (for example Discord).
- A server also contacts GitHub and the GitHub Container Registry to check for updates and to download themes and indexer definitions. GitHub sees the server's IP address in those requests, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

If you use someone else's server, ask that operator what they collect and why. This policy does not cover their server.

## The website

The website at `arclight.moviemethat.com` is a static site hosted on Cloudflare.

- No cookies, no analytics, no forms, no third-party scripts or fonts.
- Search runs locally in your browser (Pagefind). Your search terms never leave your device.
- Cloudflare processes standard request data (such as your IP address and browser user agent) to deliver and protect the site, under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- We do not log or access that data. We only see the aggregate numbers Cloudflare shows by default in its dashboard.

## The mobile apps

The Arclight apps for iOS and Android are companion apps. You enter the address (IP or hostname) of your own server, and the app shows the interface that server provides.

**Stored on your device**

- The address(es) of the server(s) you added.
- A sign-in token for your server, kept in the iOS Keychain or the Android Keystore.
- App settings (for example whether the biometric lock is on).

**Sent to your server**

Everything you do in the app goes only to the server you entered. We do not receive it.

**Permissions**

| Permission | Why | Required? |
|---|---|---|
| Local network | To reach a server on your home network. | Only if your server is on your local network |
| Notifications | To show push notifications from your server. | Optional |
| Camera | To scan a pairing QR code. No photos or video are saved or sent. | Optional |
| Biometrics (Face ID, Touch ID, Android biometrics) | For an optional app lock. The operating system does the check. Biometric data never leaves the OS and is never available to the app or to us. | Optional |

**What the apps do not do**

No ads. No tracking. No analytics or crash-reporting SDKs. No data sold or shared for advertising. No account creation in the app. Accounts live on your server.

## Push notifications and the push relay

Push notifications are optional. If you turn them on:

1. Apple (APNs) or Google (FCM) gives your device a **push token**.
2. The app registers that token with **your own server** and with the **Arclight push relay**. The project runs the relay on Cloudflare.
3. When your server has something to tell you, it sends the notification to the relay. The relay forwards it to Apple or Google, who deliver it to your device.

**What the relay stores:** the push token and a random server identifier. Nothing else.

**What the relay does not store:** notification content. It passes through to Apple or Google and is not kept after delivery.

**When the relay deletes tokens:**

- When you turn off push or sign out and the app unregisters.
- When Apple or Google report the token as invalid.
- After 90 days without use.

Apple and Google process push tokens and deliver notifications under their own privacy policies. To remove relay data sooner, see [Delete your data](/legal/data-deletion/).

## Legal bases (GDPR)

- **Website delivery and security:** legitimate interests (Article 6(1)(f)). We have an interest in a working, protected site, and the data involved is limited to standard request data handled by Cloudflare.
- **Push notifications:** consent (Article 6(1)(a)). You choose to enable them, and you can withdraw consent at any time by turning them off in the app or in your device settings.

## Your rights

Depending on where you live, you may have the right to:

- access the personal data we hold about you;
- have it corrected or deleted;
- object to or restrict its processing;
- receive a copy in a portable format;
- withdraw consent at any time;
- complain to your local data protection supervisory authority.

The only data we could hold about you is a push token and server identifier at the relay, plus standard request data at Cloudflare. To use your rights, email `privacy@moviemethat.com`. We hold no names or accounts, so we may need the push token or server identifier to find your record. We reply within one month.

### California (CCPA/CPRA)

We **do not sell** personal information and we **do not share** it for cross-context behavioral advertising. California residents may ask what we hold and ask for deletion, and we will not treat you differently for doing so. Email `privacy@moviemethat.com`.

## International transfers

Cloudflare, Apple and Google operate globally, so data they process (website request data, push tokens, push delivery) may be handled in countries other than your own, including the United States. These providers rely on safeguards such as the EU-US Data Privacy Framework and standard contractual clauses. See their policies for details.

## Retention

| Data | Kept for |
|---|---|
| Website request data at Cloudflare | Per Cloudflare's retention. We keep nothing ourselves. |
| Push token and server identifier at the relay | Until unregistered, reported invalid by Apple or Google, or 90 days unused. |
| Notification content | Not stored after delivery. |
| Data on your device | Until you remove the server, sign out or uninstall. |
| Data on a server | Set by the server operator. |

## Children

Arclight is not directed to children under 13 (under 16 in the European Economic Area). The project does not knowingly collect personal information from anyone, children included. If you think a child's push token has reached the relay, email `privacy@moviemethat.com` and we will delete it.

## Changes to this policy

We post changes on this page and update the "Last updated" date. If a change is significant, we will say so in the release notes.

## Contact

Privacy questions and requests: `privacy@moviemethat.com`. Anything else: `support@moviemethat.com`. If you have a concern, please email us first. We will try to settle it informally.
