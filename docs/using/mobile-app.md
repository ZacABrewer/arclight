# Mobile app

The Arclight app for iPhone, iPad and Android is a companion to your own server, like the Home Assistant or Jellyfin apps. It connects to the Arclight server you already run and shows the same interface you see in a browser: admins get the full app, everyone else gets the request portal. What the app adds is the phone side: notifications on your lock screen, and links that open in the phone's browser.

The app does not include a server and does not store your library. Without a running Arclight server it has nothing to show.

## Get the app

Download links are at [arclight.moviemethat.com](https://arclight.moviemethat.com/). The **Mobile app** section in Arclight (see below) links there too.

## Pair your phone with your server

Everyone can do this, including people who only use the request portal.

1. In Arclight in a browser, open your profile (the avatar menu > **Profile and notifications**, or **Profile** in the request portal) and find **Mobile app**. Admins also find it under Settings > Notifications.
2. Open the app on your phone and scan the QR code. If you cannot scan it, type the address shown under the code into the app instead.
3. Sign in with your usual Arclight account.

The QR code holds only your server's address (`arclight://pair?url=...`), no password or key. The address comes from the **Application URL** under Settings > Requests when an admin has set it, otherwise from the address you opened Arclight with. If phones reach your server at a different address (for example through a reverse proxy or a Cloudflare Tunnel), an admin should set the Application URL to that address first. See [Exposing it outside your home](../getting-started/exposing-outside-home.md) if your phone should work away from home.

To use a different server later, open the avatar menu (or the portal header) in the app and choose **Switch server**.

## Notifications on your phone

1. In the app, open your profile.
2. Turn on **Notifications on this device** and allow notifications when the phone asks.
3. Pick the events you want, the same three as for browser notifications:
   - Requests: your requests are approved, declined or fail (new requests too if you manage them).
   - Availability: something you requested is ready to watch.
   - Issues: updates on issues you reported (new issues too if you manage them).

These event choices are per user and apply to your browsers and your phones alike. Tapping a notification opens the matching page in the app.

Inside the app, the browser notification switch is replaced by this one; the app does not use web push.

Turning the switch off removes the phone from your server and stops its notifications. You can also remove a phone from the device list under **Mobile app** in a browser, for example a phone you no longer have.

### How notifications reach your phone

Apple and Google only deliver notifications to an app from its publisher's servers, so your server sends them through the Arclight push relay at `arclight-push.moviemethat.com`. The relay passes each notification to Apple or Google and does not store its content. Your server never holds an Apple or Google key, and the relay never sees your library or account.

Each paired phone gets its own relay ID and secret. The secret stays on your server: it is never shown in the interface or API, is masked in the audit log, and is left out of backup archives. After restoring a backup, turn **Notifications on this device** off and on again in the app.

Server admins can point Arclight at a different relay or turn phone notifications off completely with environment variables; see [Operations](../OPERATIONS.md#mobile-app-push-relay).

## Device list and test notifications

The **Mobile app** section lists your paired phones with their app version and when they last registered. Each row has:

- **Send test**: sends a test notification to that phone straight away. You can send one every few seconds per phone.
- **Remove**: unpairs the phone.

Admins see every user's phones under Settings > Notifications > Mobile app and can test or remove any of them.

If a row shows a warning, the last delivery to that phone failed. "Rate limited" means the relay asked your server to slow down; Arclight waits and tries once more. A phone that uninstalled the app, or whose notifications token expired, is removed automatically on the next notification.

## Troubleshooting

| Symptom | What to check |
|---|---|
| The app cannot connect after scanning | The address under the QR code must be reachable from the phone. On mobile data a home-network address (`192.168...`) does not work; set the Application URL to an address that does. |
| No notifications arrive | Send a test from the device list. If it says sent but nothing appears, check the phone's notification settings for Arclight. If it says phone notifications are turned off on this server, the admin set `ARCLIGHT_PUSH_RELAY=off`. |
| "Notifications are turned off for Arclight in the phone's settings" | Allow notifications for Arclight in the phone's Settings, then turn the switch on again. |
| A phone disappeared from the list | The relay reported it gone (app removed or token expired). Turn notifications on again in the app. |
| Notifications stopped after a restore | Backups leave phones out on purpose. Turn notifications off and on in the app. |

## Related

- [Notifications](notifications.md) (connections and browser notifications)
- [Discover and requests](discover-and-requests.md)
- [Users and security](users-and-security.md)
- [API: mobile](../API.md#mobile-companion-app)
