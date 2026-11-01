---
title: Delete your data
description: How to delete data held by the Arclight app, by a server, at the push relay and on the website.
sidebar:
  order: 4
---

Last updated: 31 October 2026

Effective: 31 October 2026

This page explains how to delete your data. It is the data deletion URL for the Arclight app on Google Play.

## The Arclight app

Data stored by the app lives on your device only. To remove it:

- **Sign out:** removes the sign-in token for that server.
- **Remove a server:** removes the server address and its token from the app.
- **Uninstall the app:** removes all app data from your device, including settings.

Signing out, removing the server or uninstalling also **unregisters push notifications**. The push relay deletes your token when the app unregisters. It also deletes tokens that Apple or Google report as invalid, and tokens unused for 90 days.

You can also turn off notifications in your device settings.

## Data on a server

Your account, requests and activity live on the server you use, not with the Arclight project. We cannot see or delete them.

- **If you run the server:** you control all of it. Delete users in the web interface under Settings > Users. See [Users and security](/docs/using/users-and-security/).
- **If someone else runs the server:** ask that operator to delete your account and data. Operators can delete users themselves, and a deleted user's sessions end immediately.

## Push relay data

The relay holds only a push token and a random server identifier. It deletes them automatically as described above. To ask us to delete them sooner, email `privacy@moviemethat.com` with the subject "Delete push data". Tell us which platform (iOS or Android) and, if you can, the push token or server identifier. We hold no names or accounts, so we need something to find the record. We will confirm when it is done, normally within one month.

## The website

The website stores nothing about you. There are no cookies and no accounts, so there is nothing to delete. Cloudflare may keep standard request data under [its own policy](https://www.cloudflare.com/privacypolicy/).

## Questions

Email `privacy@moviemethat.com`. See also the [Privacy policy](/legal/privacy/).
