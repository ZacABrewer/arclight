---
title: Security policy
description: Supported versions, how to report a vulnerability in Arclight, and how the mobile apps and push relay protect data.
sidebar:
  order: 8
---

Last updated: 31 October 2026

Effective: 31 October 2026

## Supported versions

Only the **latest release** (the `:latest` image or the newest `vX.Y.Z` tag) receives security fixes. The `:develop` image follows the main branch and may contain unreleased changes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report it privately through GitHub:

1. Open the [Arclight repository](https://github.com/ZacABrewer/arclight).
2. Go to the **Security** tab.
3. Choose **Report a vulnerability**.

Include:

- the Arclight version (Settings > System, or the image tag);
- how it is deployed (Docker, native);
- the steps to reproduce it.

If you cannot use GitHub, email `support@moviemethat.com` with the subject "Security".

## What to expect

- You get an answer in the advisory thread (or by email).
- Fixes ship as a new image tag and are credited in the release notes unless you ask us not to.
- Please give us reasonable time to fix a problem before you share it publicly.

## Hardening your server

The full list is in [SECURITY.md](https://github.com/ZacABrewer/arclight/blob/main/SECURITY.md) and in [Users and security](/docs/using/users-and-security/). Highlights:

- keep the login on and use a long, unique password;
- finish the setup wizard before anyone else can reach the server;
- do not publish port 7878 straight to the internet. Use HTTPS through a reverse proxy, a Cloudflare Tunnel or a private network;
- treat the API key like a password;
- leave the Docker socket unmounted unless you want automatic updates.

## Security of the apps and the push relay

- **Sign-in tokens** are stored in the iOS Keychain or the Android Keystore.
- **HTTPS** is used for the push relay and is the default for servers.
- **Cleartext HTTP** is allowed only to servers you choose, for example on a home network. Plain HTTP is not encrypted. Anyone on the same network could read or change the traffic, so use it only on a network you trust. Prefer HTTPS when you can.
- **Biometric lock** is handled by the operating system. No biometric data reaches the app or us.
- **The push relay** stores only a push token and a random server identifier, and it does not keep notification content after delivery. The Apple and Google credentials used to send pushes are held only by the relay.
- **No third-party analytics or crash SDKs** run in the apps.

See the [Privacy policy](/legal/privacy/) for more.
