# Notifications

Arclight can tell you, or other apps, when something happens: a release was grabbed, a file was imported, a health check failed, a download stalled, someone made a request. This page covers Settings > Notifications (connections to Discord, Slack, Telegram, ntfy, email, Home Assistant, MQTT and many more), the events you can pick, routing and filters, message templates, quiet hours, how delivery is retried and logged, personal destinations for your users, and browser push notifications. Everyone benefits from at least one connection; the health events in particular tell you early when a download client, VPN or disk has a problem.

Three Notification connection types (Jellyfin, Emby and Plex) do a different job: they ask your media server to rescan after an import. Those are covered in [Media servers](media-servers.md).

## Where things live

| What | Where |
|---|---|
| Add, edit, test and delete connections | Settings > Notifications |
| Quiet hours, daily summary and the switch for personal destinations | Settings > Notifications, "Quiet hours and daily summary" |
| Personal destinations (a user's own Telegram, ntfy, Discord and so on) | The user's profile page, or Account in the request portal |
| Browser (web push) notifications, per user | Your profile page, "Show notifications in this browser" |
| Phone notifications (the Arclight mobile app) | Your profile page in the app, "Notifications on this device"; pairing under "Mobile app". See [Mobile app](mobile-app.md) |
| Daily admin digest of pending requests and open issues | Settings > Requests, "Daily digest" |

## Adding a connection

1. Go to Settings > Notifications and press **Add connection**.
2. Choose a type (table below, with a section per service further down).
3. Give it a name, fill in the type's fields, and tick the events you want under **Notify on**.
4. Press **Test**. Arclight sends a test message and reports success or the reason it failed (for example `network` or `unauthorized`).
5. Save.

Connections can be switched off without deleting them. Editing a saved connection and pressing Test tests the values on screen, including unsaved edits. Secrets (tokens, passwords, webhook URLs) are never shown again after saving; leave the masked value in place to keep the stored one.

You can have as many connections as you like, of the same type or different ones. Each one has its own events, filters, templates and delivery settings, so "everything to a Discord channel, only health problems to my phone" is just two connections.

## Connection types

| Type | Delivers to | What you need |
|---|---|---|
| [Discord](#discord) | A channel, as rich embeds with poster, quality, size, links | A channel webhook URL |
| [Slack](#slack) | A Slack channel | An Incoming Webhook URL |
| [Microsoft Teams](#microsoft-teams) | A Teams channel through a Workflows webhook | The Workflows webhook URL |
| [Telegram](#telegram) | A chat, group or channel through a bot | Bot token and chat ID |
| [Matrix](#matrix) | A Matrix room | Homeserver, access token, room |
| [Mattermost](#mattermost) | A Mattermost channel | An incoming webhook URL |
| [Rocket.Chat](#rocketchat) | A Rocket.Chat channel | An incoming webhook URL |
| [Google Chat](#google-chat) | A Google Chat space | A space webhook URL |
| [Signal](#signal) | Signal numbers or groups, through your own signal-cli-rest-api | Server URL, sender number, recipients |
| [ntfy](#ntfy) | Phones and desktops through ntfy | Server and topic |
| [Gotify](#gotify) | Your Gotify server | Server URL and app token |
| [Pushover](#pushover) | The Pushover app | API token and user key |
| [Pushbullet](#pushbullet) | Your devices, a channel or another user | Access token |
| [Prowl](#prowl) | iPhone through Prowl | API key |
| [Bark](#bark) | iPhone through Bark | Device key |
| [Join](#join) | Android devices through Join | API key |
| [SimplePush](#simplepush) | The SimplePush app | Key |
| [Home Assistant](#home-assistant) | A notify service and/or an event on the HA event bus | Base URL and a long-lived token |
| [MQTT](#mqtt) | A topic on an MQTT broker | Broker host (and credentials if needed) |
| [Twilio](#twilio) | SMS or WhatsApp | Account SID, auth token, sender, recipients |
| [Apprise](#apprise) | Anything Apprise supports, through an Apprise API server | Server URL and a config key or Apprise URLs |
| [Notifiarr](#notifiarr) | A Discord channel through Notifiarr | API key and channel ID |
| [LunaSea](#lunasea) | The LunaSea app | The custom notification URL |
| [Email](#email) | One or more addresses over SMTP | An SMTP server |
| [Webhook](#webhook) | Any URL, as a JSON event or your own body | A URL |
| [Custom Script](#custom-script) | A program on the Arclight machine | The script path |
| Jellyfin, Emby, Plex | Rescans a media server library | See [Media servers](media-servers.md) |

Which events each type can receive: nearly every messaging type handles every event except file renames. Webhook, Custom Script and MQTT handle all events, and so does Home Assistant when its mode is Event or Both (in Notify mode it skips renames). Jellyfin and Plex handle only library changes (imports, upgrades, renames, deletions, subtitles, transcodes); Emby handles those too, and with "Notify" on it also handles grabs, imports, upgrades, health issues, application updates and manual-interaction events.

Defaults are shown in brackets in the sections below. Fields marked "required" must be filled in; everything else is optional.

### Discord

A channel receives each event as an embed with poster, quality, size and links.

- **Webhook URL** (required): Channel settings > Integrations > Webhooks in Discord.
- **Username**, **Avatar URL**, **Author** (default: the instance name).
- Fields shown on grab, import/upgrade and manual-interaction embeds: overview, rating, genres, quality, codecs, group, size, languages, subtitles, links, release, poster, fanart, indexer, custom formats, custom format score. Untick the ones you do not want.

### Slack

- **Webhook URL** (required): create a Slack app, turn on Incoming Webhooks and add a webhook for a channel.
- **Channel**, **Username**, **Icon URL**, **Icon emoji**: overrides that only older "legacy" webhooks honour. A modern app webhook always posts to the channel it was created for under the app's own name.

### Microsoft Teams

- **Webhook URL** (required): in Teams, open the channel, add a Workflow from the "Post to a channel when a webhook request is received" template, and copy the URL it gives you.

Teams has retired the old connector webhooks, so this type uses the Workflows (Power Automate) kind. If the workflow is switched off or its owner leaves, the URL stops working and the test fails.

### Telegram

- **Bot token** (required): from @BotFather.
- **Chat ID** (required): negative for groups. A bot such as @userinfobot can tell you yours.
- **Topic ID**: forum groups only.
- **Send silently** (off): deliver without a sound.
- **Include link** (on).

### Matrix

- **Homeserver URL** (`https://matrix.org`): your server's base address.
- **Access token** (required): of the account that posts. A dedicated bot account is best, and it must already be in the room.
- **Room** (required): the room ID (`!abc:example.com`, under Room settings > Advanced) or an alias (`#room:example.com`).
- **Message type** (`m.notice`): a notice is marked as coming from a bot, so clients may not ping for it. `m.text` sends an ordinary message.

### Mattermost

- **Webhook URL** (required): Integrations > Incoming Webhooks > Add.
- **Channel**, **Username**, **Icon URL**: overrides. The server must allow integrations to override usernames and profile pictures for the last two to take effect.

### Rocket.Chat

- **Webhook URL** (required): Administration > Workspace > Integrations > New > Incoming. The URL includes its token.
- **Channel** (`#channel` or `@user`; blank uses the integration's default), **Alias**, **Avatar URL**, **Emoji**.
- **Large poster** (off): show the poster as a large image instead of a thumbnail.

### Google Chat

- **Webhook URL** (required): in the space, Apps & integrations > Webhooks. The URL carries a key and token in its query string, so treat it like a password.
- **Thread key**: post every message into one thread. Blank starts a new thread per message.

### Signal

Signal has no official bot API, so this type talks to a [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) server that you run yourself, for example as another container next to Arclight.

- **Server URL** (required): for example `http://signal-api:8080`.
- **Sender number** (required): the number registered or linked in that server, in international format (`+15550100`).
- **Recipients** (required): phone numbers, group IDs (`group.…`, listed by the server's groups endpoint) or account UUIDs.
- **Username** and **Password**: basic auth, only if a proxy in front of the server asks for it. Set both or neither.
- **Attach poster** (on).

### ntfy

- **Server URL** (`https://ntfy.sh`): use your own server, for example `https://ntfy.example.com`, for privacy.
- **Topics** (required).
- **Priority** 1 to 5 (3), **Tags**, **Click URL**.
- **Access token** (preferred) or **Username** and **Password**, for protected topics.

### Gotify

- **Server URL** and **App token** (from the Gotify Apps page).
- **Priority** 0 to 10 (5), **Markdown** (on).

### Pushover

- **API token** and **User key** (30 characters each).
- **Devices** (empty means all), **Priority** -2 to 2 (0), **Retry** (60 s) and **Expire** (3600 s) for emergency priority, **Sound**.

### Pushbullet

- **Access token** (required): Pushbullet Settings > Account.
- Optionally one target: a **Device** (its iden), a **Channel tag** (a channel you own) or an **Email** (another Pushbullet user). With none set, the push goes to all your devices. Setting more than one is rejected.

### Prowl

- **API key** (required): from the Prowl website. Separate several keys with commas to reach several accounts.
- **Priority** -2 to 2 (0).
- **Provider key**: only if Prowl issued you one for higher limits.

### Bark

- **Server URL** (`https://api.day.app`): change it only if you run your own bark-server.
- **Device key** (required): shown in the Bark app.
- **Group** (`Arclight`), **Sound**, **Icon URL** (defaults to the poster).
- **Level**: active (default), time sensitive (can break through Focus), passive (silent) or critical (ignores mute).

### Join

- **API key** (required): in the Join web app under Join API.
- **Device IDs** or **Device names**: which devices to notify. Leave both empty for all; names are used only when no IDs are set.
- **Priority** -2 to 2 (0).

### SimplePush

- **Key** (required): shown in the SimplePush app.
- **Event**: a name, so the app can give Arclight its own ringtone and vibration.

Messages are sent without end-to-end encryption; that mode is not supported.

### Home Assistant

- **Base URL** (required): for example `http://homeassistant.local:8123`.
- **Access token** (required): a long-lived token from your Home Assistant profile (Security).
- **Mode** (Notify): Notify calls a notify service, Event fires an event on the event bus for your automations, Both does each.
- **Notify service** (`notify`): the part after `notify.`, for example `mobile_app_pixel`. Plain `notify` uses the default service.
- **Event type** (`arclight_event`): the event name used in Event mode. The event data carries the title, body, severity, link and the full Arclight event, so an automation can pick fields out of it.

In Notify mode the Companion apps get the poster and up to three action buttons (Approve, Decline, View) on request events.

### MQTT

Publishes each event as JSON to a broker, ready for Home Assistant, Node-RED and similar tools.

- **Host** (required) and **Port** (1883 plain, 8883 TLS), **Use TLS** (off). **Allow invalid certificates** (off) accepts self-signed certificates.
- **Username** and **Password**, if the broker needs them.
- **Client ID**: must be unique per connection on the broker. A random one is filled in for you.
- **Topic** (`arclight/{{eventType}}`): a [template](#message-templates), so the default gives one topic per event type. Wildcard characters are replaced and empty levels dropped.
- **QoS** 0 or 1 (1: wait for the broker to confirm), **Retain** (off), **Timeout** (10000 ms).

The payload contains `eventType`, `title`, `body`, `subject`, `severity`, `link`, `posterUrl` and the raw `event`.

### Twilio

- **Account SID** (starts with `AC`) and **Auth token**: from the Twilio console.
- **From** (required): a sending number in international form (`+15550100`) or a Messaging Service SID (starts with `MG`).
- **To** (required): one or more recipient numbers in international form.
- **Channel** (SMS): SMS, or WhatsApp through Twilio (the sender must be WhatsApp-enabled).
- **Include link** (on), **Attach poster** (off; MMS or WhatsApp only, and MMS needs US or Canadian numbers).

Twilio charges per message, so keep this connection to a few important events, or use a rate limit (see [Reliability](#reliability-retries-rate-limits-and-the-delivery-log)).

### Apprise

[Apprise](https://github.com/caronc/apprise-api) is a gateway that can reach dozens of services. Arclight talks to an Apprise API server you run.

- **Server URL** (required): for example `http://apprise:8000`.
- Exactly one of:
  - **Config key**: a configuration saved on the Apprise server (stateful). **Tags** then limits which of its services are used; empty means all.
  - **Apprise URLs**: the service URLs themselves, for example `tgram://bottoken/ChatID` (stateless).
- **Format** (Markdown): text, Markdown or HTML, for services that care.
- **Attach poster** (off): the server downloads the image from its URL.
- **Username** and **Password**: basic auth if the server sits behind a proxy.

### Notifiarr

Notifiarr relays an embed from its own bot to a Discord channel (passthrough).

- **API key** (required): Notifiarr profile > API keys, with the passthrough integration enabled.
- **Channel ID** (required): the Discord channel number (turn on Developer Mode in Discord, right-click the channel, Copy Channel ID).
- **Colour**: a six-digit hex colour. Blank colours the embed by severity.

### LunaSea

- **Custom notification URL** (required): copied from LunaSea under Settings > Notifications. It ends in `/v1/custom/user/<id>` or `/v1/custom/device/<id>`.

### Email

- **Host**, **Port** (587), **Security**: None, STARTTLS or TLS (STARTTLS).
- **Username** and **Password** (blank means no authentication).
- **From**, **To**, **CC**, **BCC**.
- **Subject prefix** (`[Arclight]`).

### Webhook

Sends each event to any URL you choose.

- **URL** (required), **Method**: POST, PUT or PATCH (POST).
- **Username** and **Password** for basic auth, and extra **Headers** (for example an API key).
- **Body template** and **Content type** (`application/json`): leave the body blank to send the whole event as JSON (with an `eventType` field and, for request events, an `actions` list of links). Fill it in to send exactly the body the receiving service expects. See [Message templates](#message-templates) for an example.

### Custom Script

- **Path** (absolute), **Arguments** (split on spaces), **Timeout** (60000 ms, 1000 to 3600000).
- The event is passed as `ARCLIGHT_*` environment variables, starting with `ARCLIGHT_EVENT_TYPE`; lists are joined with `|`.

A script runs with Arclight's own permissions. In Docker the script must exist inside the container. A script that hangs is killed after the timeout.

## Events (Notify on)

| Switch | Fires when | Notes |
|---|---|---|
| On grab | A release is sent to a download client | |
| On download | A download was imported into the library | New files only |
| On upgrade | An imported file replaces a worse one | |
| On rename | Files were renamed | Also fires when a transcode rule rewrites a file in place |
| On series add | A series was added to the library | |
| On movie add | A movie was added to the library | |
| On series delete | A series was deleted | Also used for retention sweep summaries |
| On movie delete | A movie was deleted | Also used for retention sweep summaries |
| On file delete | A file was deleted (including replaced by an upgrade) | |
| On health issue | A health check started failing | Errors only, unless "Include health warnings" is on. Also carries **Health scan found problems**: a library [health scan](health-scan.md) found new broken or wrong files (sent whatever their severity) |
| On health restored | A failing health check recovered | Same rule for warnings |
| On application update | Arclight was updated | |
| On manual interaction required | An import needs you (unknown series, unmatched file, and so on) | See [Activity](activity.md) |
| On request created | A new request needs attention | Sitewide: admins hear about every user's requests |
| On request approved | A request was approved | |
| On request declined | A request was declined | |
| On request available | A requested title is now available | Subtitle and audio language requests use the request events too (created, approved, declined, completed), with the language in the title, for example "The Matrix (Spanish subtitles)". They have no failed event |
| On issue created | A user reported a problem with a title | |
| On issue updated | An issue changed | |
| Download stalled | A download has stopped making progress | Download problems group |
| Kill switch paused downloads | The VPN kill switch paused downloads | One alert per lockdown, with the reason. If it lasts 30 minutes you get an urgent reminder |
| Kill switch released | Downloads resumed after a lockdown | |
| Import problem | An import failed or was blocked | Includes the message |
| Disk space low | A disk-space health check went to warning or error | Errors are urgent |
| Download recovered or replaced | Any other noteworthy download event, such as a stalled download recovering or a release being replaced | |
| Daily summary | The [daily summary](#daily-summary) was built | |
| New podcast episodes | A podcast feed has new episodes | Only while [Podcasts](podcasts.md) are on. Not sent when you subscribe |
| Podcast episode downloaded | A podcast episode was saved to the podcast folder | With its size and path |

Other settings on each connection:

| Setting | Default | What it does |
|---|---|---|
| Include health warnings | Off | Also send health Warnings. Errors are always sent when On health issue is on |
| Tags | none | Only notify for series and movies carrying a matching tag. Empty means all media. Events that are not about a title (health, updates, requests) always pass |
| Respect quiet hours | On | Hold non-urgent alerts during quiet hours (see below) |
| Enable | On | Off keeps the connection but sends nothing |

The request and issue events include links to the item only when the application URL is set under Settings > Requests. Health notifications work the same way: their **More Info** link is an absolute address built from the Application URL and opens the matching entry in System > Health docs. With no Application URL set, the link is left out.

Which events to pick: a good starting set for a phone connection is On health issue, On health restored, On manual interaction required, Kill switch paused downloads and On application update. Add On grab and On download only if you want a message per download; they can be chatty.

### Daily admin digest

Settings > Requests has a **Daily digest**: once a day at the **Digest time** (server local time, default 09:00 when enabled; off by default) Arclight sends a summary of pending requests and open issues. Nothing is sent if there is nothing pending. **Send digest now** sends one immediately. The digest goes to every connection that has On request created or On issue created switched on.

## Routing: who gets what

Routing is the combination of three things on each connection:

1. **Events**: the "Notify on" switches decide which kinds of event the connection hears about at all.
2. **Tags**: limit title events to series and movies that carry one of the chosen [tags](tags.md).
3. **Filters**: narrow things further.
   - **Media kinds**: only series, movies, music or audiobooks.
   - **Qualities**: only events whose release or file is one of the listed qualities, for example `WEBDL-1080p`.
   - **Users**: only request and issue events from the listed people (the requester or reporter).

An empty list means "no restriction". Events that are not about a title or a person (health, kill switch, updates) always pass the media-kind and quality filters, and events without a user always pass the user filter, so a filter cannot accidentally hide a health problem.

A few common set-ups:

- Everything to one Discord channel, and health problems and the kill switch to your phone through ntfy: two connections with different events.
- Only 4K grabs to a "4K" channel: a connection with On grab, On download and the quality filter set to the 2160p qualities.
- A family channel that only hears about movies: media kind filter set to movies.

## Quiet hours

Quiet hours hold non-urgent alerts during a time window and send them as one batch once it ends, so a stalled download at 3 a.m. does not wake your phone.

**Global quiet hours** are in Settings > Notifications under **Quiet hours and daily summary**:

- **Start** and **End** (default 22:00 and 07:00, server local time). An end earlier than the start means the window runs past midnight.
- **Days**: the days on which a quiet period starts. A window that runs past midnight belongs to the day it starts on.
- The page shows how many alerts are being held and whether quiet hours are in effect right now.

Each connection decides whether it follows them with **Respect quiet hours** (on by default). A connection can also have **its own quiet hours** that replace the global ones for that connection only; leave it on "follow global" to use the shared window. This is handy for a phone connection that should be quiet overnight next to a Discord channel that never sleeps.

What is held and what is not:

- Held alerts are stored and sent when the window ends: a single alert as itself, several as one "held alerts" message. Alerts held for more than seven days are dropped.
- **Urgent alerts** go through anyway. Examples are a disk-space error and the 30-minute kill-switch reminder.
- **Test messages** always go through.

## Daily summary

Once a day, at the **Summary time** (default 08:00, switched on by default) Arclight builds a summary of the previous 24 hours: what was grabbed, imported, failed, stalled, recovered or replaced, kill-switch lockdowns and their total time, free space per root folder and download folder with the change since the last summary, up to ten problems, open health issues and what is still downloading. It goes to every connection with **Daily summary** ticked. The latest summaries are kept for 30 days.

## Message templates

By default each service gets Arclight's own wording. A connection can override the title and body per event type, or for all events with the `default` template. A blank title or body keeps the default text for that part. A template for one event type wins over `default`. Test messages keep their normal text unless you give the connection a template specifically for the test event, so "Send test" still proves delivery even if a template is broken.

The syntax is small and never runs code:

| Write | Result |
|---|---|
| `{{mediaTitle}}` | The value of a variable. Unknown variables produce nothing |
| `{{event.media.year}}` | Dots reach into the raw event |
| `{{#episode}}…{{/episode}}` | The inside appears only when the variable has a value |
| `{{^episode}}…{{/episode}}` | The inside appears only when it has no value |
| `{{json event.release}}` | The value as JSON (mainly for webhook bodies) |

Sections must be closed; an unbalanced template is rejected with a message pointing at the problem. A preview shows the rendered result for a sample event before you save.

Variables:

| Variable | Holds |
|---|---|
| `instanceName`, `applicationUrl` | Name and public URL of this Arclight |
| `eventType`, `timestamp` | Event type (for example `grab`) and when it happened (ISO-8601) |
| `subject`, `title`, `body` | The default subject, headline and message text |
| `severity` | info, success, upgrade, warning or error |
| `link`, `posterUrl`, `fanartUrl` | Link to the item and its images |
| `mediaTitle`, `mediaYear`, `mediaType`, `overview` | Series, movie, artist or author, year, kind (series, movie, music, audiobook) and plot |
| `episode`, `episodeTitle`, `album`, `book` | Episode label such as S01E02-E03, episode titles, album, book |
| `quality`, `size` | For example WEBDL-1080p and 1.4 GB |
| `releaseTitle`, `releaseGroup`, `indexer`, `downloadClient` | Details of the release |
| `requestedBy`, `reason` | Who requested it; the decline reason |
| `issueType`, `issueMessage` | Issue category and the report or newest comment |
| `healthMessage`, `newVersion`, `message` | Health text, new version, and free-form text some events carry |
| `fieldsText` | Every detail line as `Name: value` |
| `event` | The whole raw event. Reach in with dots, for example `event.media.tmdbId` |

Examples:

```
Title:  {{mediaTitle}} ({{mediaYear}}){{#episode}} {{episode}}{{/episode}}
Body:   {{subject}} in {{quality}}, {{size}}{{^releaseGroup}} (unknown group){{/releaseGroup}}
```

A webhook body template that fits a service wanting its own JSON shape:

```
{
  "text": "{{title}}",
  "severity": "{{severity}}",
  "link": "{{link}}",
  "release": {{json event.release}},
  "tmdbId": {{json event.media.tmdbId}}
}
```

In a webhook body (and any other JSON content type) every plain `{{variable}}` is escaped for use inside a JSON string, so quotes and line breaks in a title cannot break the document. `{{json …}}` writes the value as JSON on its own, including quotes for text, and writes `null` when the value does not exist, so do not wrap it in quotes. After rendering, a JSON body is checked; if it is not valid JSON the delivery fails with an "invalid settings" error and is not retried. The MQTT topic uses the same template language.

## Reliability: retries, rate limits and the delivery log

Arclight does not give up on the first hiccup.

**Retries.** Every connection has **Attempts** (default 3, from 1 to 6), counting the first try. A failed attempt is retried when the problem may pass: the service could not be reached, it timed out, it answered "too many requests" (429) or it had a server error (5xx). The wait doubles each time: 2 s, 4 s, 8 s and so on, but 5 s, 10 s, 20 s after a 429, and never more than 60 s. Problems that retrying cannot fix, such as a wrong token, other 4xx answers or invalid settings, fail straight away. Set Attempts to 1 to turn retries off.

**Rate limit.** **Rate limit per minute** (0 means unlimited, up to 600) caps how many messages a connection sends in a minute. Alerts over the cap are not lost: they are held and sent together as one "held alerts" message as soon as the minute has room. This protects chat channels and paid services (SMS) from a burst, for example when a whole season is imported.

**Delivery log.** Each connection keeps its last 100 delivery attempts. An entry shows the event, its headline, when it happened, how many attempts it took, and its state:

| State | Meaning |
|---|---|
| Sent | Delivered |
| Failed | All attempts failed. The error is shown, with secrets removed |
| Held | Waiting for quiet hours to end |
| Rate limited | Waiting for room under the rate limit |
| Skipped | Reserved for alerts that were deliberately not sent. Alerts that a filter or tag excludes are simply not sent, and do not appear in the log |

Test messages are logged too and marked as tests.

**Last error.** A connection remembers its last error, when it last failed, when it last succeeded and how many failures in a row it has had. When connections keep failing, System > Health reports "Notifications keep failing". See [Troubleshooting](../TROUBLESHOOTING.md#notifications-keep-failing).

**Send test.** Press **Test** in a connection's form to send a test message using the values on screen. The result is the service's answer (or a short code such as `network`, `unauthorized` or `invalidSettings`). The same test is available for all connections at once.

## Personal destinations

Besides the connections you set up for the whole server, every user can add their **own** destinations, so a person can get their request updates on their own Telegram, ntfy topic or Discord without an admin setting anything up. This works for request-portal users too.

**Adding one.** Open your profile page (admins and app users) or **Account** in the request portal, go to the notifications section and add a destination. Pick a service, fill in its fields (the same as the sections above), choose the events you want, and press **Test**. You can add up to 20 destinations.

**Services.** Discord, Slack, Teams, Telegram, Matrix, Mattermost, Rocket.Chat, Google Chat, Signal, ntfy, Gotify, Pushover, Pushbullet, Prowl, Bark, Join, SimplePush, Home Assistant, Twilio, Apprise, LunaSea and Webhook. Email (SMTP relay), MQTT, Custom Script and the media servers are server-owner tools and are not offered here.

**Events.** Everything is about the user's own activity:

| Event | Sent when |
|---|---|
| Request approved | Your request was approved |
| Request declined | Your request was declined |
| Request available | Something you requested can be watched |
| Issue updated | An issue you reported changed |
| Watchlist available | An import of a title on your watchlist |
| Request pending | Someone made a request (only for people who can manage requests) |
| Issue created | Someone reported an issue (only for people who can manage issues) |

All but the last two are on by default. Each destination also has an on/off switch, its own message templates and optional quiet hours of its own.

**Limits.** Personal destinations send at most 20 messages a minute (extra alerts are held and batched, as above), use 3 attempts, and have their own delivery log.

**Privacy and safety for the server.**

- Non-admin users cannot point a destination at the Arclight machine or your home network: localhost, private and link-local addresses and local-only names (a single word, or ending in `.local`, `.lan`, `.internal` and similar) are refused. Otherwise a user could make your server call into your LAN. Admins are not restricted.
- Non-admins see only the category of an error ("could not reach the server", "rejected the credentials") and not the raw text the remote server returned.
- Secrets are masked after saving, like server connections.

**Admin switch.** An admin can turn the whole feature off under Settings > Notifications, **Quiet hours and daily summary**, with the personal destinations switch. While it is off, nobody can add or test a destination and none are sent to; saved ones are kept.

For the earlier per-user agent settings in Settings > Users, see [Discover and requests](discover-and-requests.md#users-and-permissions).

## Browser (web push) notifications

Separate from connections: each user can receive notifications in their own browser, with no third-party service.

1. Open your profile page and turn on **Show notifications in this browser**.
2. Allow notifications when the browser asks.
3. Choose what you want to hear about:
   - Requests: your requests are approved, declined or fail (new requests too if you manage them).
   - Availability: something you requested is ready to watch.
   - Issues: updates on issues you reported (new issues too if you manage them).
4. Press **Send test** to confirm. It reports how many browsers received it.

The same three choices apply to phones paired through the [Arclight mobile app](mobile-app.md): one setting per user, for every browser and phone.

Notes: browser push needs HTTPS (or `localhost`). Open Arclight over HTTPS first, for example through a reverse proxy. If notifications are blocked for the site, allow them in the browser's site settings. On iPhone and iPad, add Arclight to the home screen first. Each browser you enable is its own subscription, and a subscription the browser has revoked is removed automatically.

## Weekly newsletter

Arclight can email a weekly "recently added" newsletter: the movies and episodes whose files arrived in the last seven days, with posters, grouped per series. Set it up in **Settings > Stats & collections > Newsletter**:

1. Add an **Email** connection first. Its SMTP server sends the newsletter.
2. Turn on **Newsletter**, choose the email connection and when it goes out (weekday and hour, server time).
3. Choose the recipients: **the connection's recipients** (its To, Cc and Bcc) or **all users with an email address** (sent as Bcc, so nobody sees the others). A user is left out when their account has the `newsletterOptOut` setting.
4. Check the preview (subject, recipient count and the rendered email) and press **Send now** to try it.

The `WatchStatsNewsletter` task checks every hour and sends once a week. Every send is listed with its recipient count and any error.

## Secrets and privacy

Tokens, passwords, webhook URLs and keys are stored on the server and shown masked (`********`) once saved. Leaving the mask in place when you edit keeps the stored value. Secrets are also removed from error text, logs and the delivery log, even if the remote service repeats them back in an error. Exports and API reads show the mask as well. Messages go straight from Arclight to the service you configured; with cloud services such as Discord, Slack or Twilio the message text, titles and poster links pass through them.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Test fails with `network` | Arclight cannot reach the service. In Docker, check DNS and that the container is allowed out. If Arclight runs behind the VPN, see [VPN](vpn.md) |
| Test fails with `unauthorized` | Wrong token, key or password |
| Test fails with `invalidSettings` | A field is wrong, or a webhook body template does not produce valid JSON. The message names the problem |
| Test works but nothing arrives for real events | The event switch is off, a tag or filter excludes the item, quiet hours are holding it, or health warnings are off while the issue is only a warning. Open the connection's delivery log: it says sent, failed, held or rate limited (an event that a filter or tag excluded never appears there) |
| Alerts arrive late, in a batch | Quiet hours or the rate limit held them; they go out as one "held alerts" message |
| Health notification has no More Info link | Set the Application URL under Settings > Requests |
| Email sends nothing | Check port and Security together: 587 with STARTTLS, 465 with TLS, 25 with None |
| A user cannot save a personal destination | Non-admins cannot use local or private addresses. Use a public address, or ask an admin to add the connection |

More: [Notifications are not arriving](../TROUBLESHOOTING.md#notifications-not-arriving).

## Searching your connections

A search box sits above the connection cards once there is at least one. Every word you type has to match somewhere (in any order), case does not matter, and dots, dashes and underscores count as spaces. The count next to the box shows how many match ("2 of 9"), **Select all** then selects only the matching items, and Escape or **Clear search** shows everything again. The search is kept in the address (`?q=`). It matches the name, the connection type and the events that are switched on (for example `on grab`).

## Bulk actions

Every card has a checkbox. Tick one or more and a bar appears at the bottom of the screen with "N selected", **Select all N** and the actions for the selection: **Enable**, **Disable**, **Test** (sends a test message from each), **Add tag**, **Remove tag** and **Delete**. Deleting asks first and says how many items it removes. Each item is handled on its own, so one that fails (for example a test that does not connect, or a profile still in use) does not stop the rest; a message lists what worked and why the others did not, and the failed items stay selected. On a phone the actions sit in one **Actions** menu.

## Related

- [Mobile app](mobile-app.md) (pairing by QR code, notifications on your phone)
- [Tags and tag rules](tags.md) (tags limit which items this applies to; rules can add them automatically)
- [Media servers](media-servers.md)
- [Activity](activity.md)
- [Discover and requests](discover-and-requests.md)
- [Podcasts](podcasts.md)
- [System](system.md) (health checks)
- [Troubleshooting](../TROUBLESHOOTING.md)
