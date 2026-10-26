# Calendar

The Calendar shows when episodes air and when movies are released, for everything in your library, so you can see what is coming and what is overdue. You can also subscribe to it from Google Calendar, Apple Calendar, Outlook or any other calendar app. Everyone who can sign in can open the Calendar; the iCal button is part of the same page.

Find it in the left menu under **Calendar**.

## What appears on it

- **Episodes**, on their air date. If Arclight knows the air time, the event shows that time (in your browser's local time). Otherwise it is an all-day item.
- **Movies**, on their release dates: in cinemas, digital release and physical release each show up as their own entry.

By default only monitored items are shown. Turn on **Show unmonitored** to include the rest. See [Library](library.md#what-monitored-means) for what monitored means.

## Views

Use the buttons at the top right to change the view:

| View | What it shows |
| --- | --- |
| Month | A grid of the whole month. Not available on narrow phone screens, where the Agenda is used instead. |
| Week | Seven days. |
| Day | A single day. |
| Agenda | A plain list of the anchor month, day by day. |

Use the arrows to move to the previous or next month, week or day, and **Today** to jump back to the present. The title shows the range you are looking at.

## Colors

A legend under the title explains the colors of the event bars:

| Color | Meaning |
| --- | --- |
| Downloaded | You have the file. |
| Upcoming | Not aired yet, or the air date is to be announced. |
| Missing | It should be out, but there is no file. |

Unmonitored items are drawn dimmer than monitored ones.

## Clicking an event

Click an event bar to open a small card with the poster, title, episode code and name, date and time, and a status chip. The buttons are:

- **Open**: go to the series or movie page.
- **Search**: look for a release now. It is hidden for items that are already downloaded, not yet aired, or have no air date.

If nothing is scheduled for the month you are looking at, the page says "Nothing scheduled this month" and suggests moving to another month or showing unmonitored items.

## iCal feed (subscribe from another app)

Click **iCal** on the Calendar page to get a link your calendar app can subscribe to.

1. Open **Calendar** and click **iCal**.
2. Set **Past days** (default 7) and **Future days** (default 28). These decide how far back and ahead the feed reaches. Both can be 0 to 3650.
3. Optionally switch on **Include unmonitored**.
4. Click the copy button next to **Feed URL**.
5. In your calendar app, add a new calendar by URL ("Add calendar from URL" or "Subscribe") and paste it.

Good to know:

- The link contains a secret token, because calendar apps cannot log in. Anyone with the link can read your calendar, so do not post it publicly.
- The feed looks like `http://<your-host>:<port>/api/v1/calendar/feed.ics?token=...`. Your calendar app must be able to reach that address. If you use it away from home, you need a reverse proxy or VPN into your network; the feed does not work from outside by itself.
- Episodes are entries titled `Series - S01E02 - Episode title`, with the overview as the description. Movies are all-day entries titled `Movie (Digital release)` and so on.
- Calendar apps refresh subscribed feeds on their own schedule, often every few hours to a day.
- **Regenerate URL** creates a new token. The old link stops working immediately, and every calendar app using it stops updating until you give it the new link. Use it if the link leaks. The page asks you to confirm.

## Preferences

Two display preferences change how the Calendar looks. Set them in **Settings > General**, in the **UI** section, then click **Save preferences**. They belong to your user account.

| Setting | Default | What it does |
| --- | --- | --- |
| First day of week | Monday | Choose Monday or Sunday as the first column of the month and week views. |
| Time format | 24-hour | 12-hour or 24-hour times on events. |
| Date format | Follows your language | How dates are written. An example is shown next to the choices. |

## Related

- [Library](library.md) - monitoring and what appears on the Calendar
- [Wanted](wanted.md) - everything that is missing or below cutoff
- [Users and security](users-and-security.md) - who can see what
- [FAQ](../FAQ.md)
