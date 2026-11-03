# Household profiles

One Arclight account can hold several **profiles**, one for each person who watches on it. Each profile keeps its own:

- watch progress and Continue Watching
- My List
- play queue and playlists
- player settings (subtitles, audio language, autoplay, skip intros, theme, whether Music and Audiobooks show)

Requests, the watchlist, notifications and everything else on the account stay shared. Profiles are not separate accounts: they have no password and cannot sign in by themselves.

## The owner profile

Every account has exactly one **owner** profile. It is created automatically, named after the account, and holds everything the account watched before profiles existed. The owner profile:

- cannot be deleted
- has no content limit of its own; the account's caps (Settings > Users > Manage > Caps and approval) apply to it
- is the only profile that can manage the others, and the only one that reaches anything outside the player

## Managing profiles

Admins manage the profiles of any account in **Settings > Users**: choose **Manage** on a user, then the **Profiles** tab. From there you can:

- add a profile (up to 12 for each account, the owner included)
- change its name, its initial (one or two characters shown in the avatar) and its colour
- set a **content limit**: the highest movie rating, the highest series rating and whether to hide adult titles
- set, change or remove a four-digit **PIN**
- delete a profile

A profile that has a content limit shows a **Kids** badge, and one that has a PIN shows a **PIN** badge.

Account holders can also add, edit and delete their own profiles while the owner profile is active.

## Adding and editing profiles in the player

The player's **Who's watching?** screen (in the browser, the phone app and on a TV) is where the owner profile adds and edits profiles:

- **Add profile** is the round tile with a plus at the end of the row. It shows while the owner profile is active and the account has fewer than 12 profiles. It opens the full profile page: name, colour (the first one no other profile uses is picked for you), PIN and the movie and TV rating limits. **Save** creates the profile with all of them at once. The new profile is not switched to; its tile is selected so you can choose it straight away.
- **Manage profiles** is the round pencil button under the row. It turns the screen into edit mode: the title changes to **Manage profiles**, each avatar shows a pencil, and choosing one opens its page instead of switching to it (no PIN is asked). The button becomes **Done**. **Back**, **Esc** or **Done** returns to choosing a profile.

Other profiles see neither the Add tile nor the pencil.

### Adding a second profile

The picker only appears once an account has two or more profiles, so an account with just the owner profile adds its second one elsewhere:

- in the browser and the phone app: **Add profile** in the avatar menu, or **Settings > Profiles > Add profile**;
- on a TV: **Settings > Profiles > Add profile**.

Each opens **Manage profiles** with the new-profile page already open.

## Content limits

A profile's limit is added to the account's caps, and the stricter of the two wins for each rating. For example, if the account is capped at R and the profile at PG, the profile sees PG and below. If the account is capped at PG-13 and the profile has no limit, the profile sees PG-13 and below.

Arclight enforces limits on the server, not just in the interface. Titles above the limit are left out of browse rows, search, details, the featured banner, My List and scrub thumbnails. Stream and artwork links signed for a limited profile carry that profile, so copying a link out of a Kids profile still won't play a restricted title. A link whose profile has since been deleted stops working.

## PINs

A PIN keeps someone from switching into a profile they shouldn't use, such as the owner profile from a Kids profile. Arclight asks for it when someone switches to that profile.

- After 5 wrong PINs in a row, switching to that profile is locked for 15 minutes. Each further lockout without a right PIN in between doubles the wait, up to 24 hours. Arclight tells the app how long to wait. The count belongs to the profile, so signing in again or restarting Arclight does not reset it. The right PIN resets it, and the account owner can lift a lockout at once by setting a new PIN (or removing it) for that profile.
- There is one exception for a sign-in less than 10 minutes old: it may re-select the profile it is already on without the PIN, because the password was just entered.
- PINs are stored hashed. They are never shown again and never written to the logs or the audit log.

## Which sign-ins can switch profiles

Profiles belong to a browser session or a paired Arclight app. A browser sign-in and each paired app remember their own active profile, and a switch takes effect on the next request with no new sign-in.

The browser prompt (HTTP Basic) and API keys always act as the owner profile and cannot switch. Trying to switch with them returns an error.

## What a non-owner profile can reach

A profile other than the owner can use only the player: browsing, playback, My List, its queue and playlists, and its own player settings. Every admin page and every request-portal page answers "profile-forbidden", **even on an admin account**. To manage Arclight, switch back to the owner profile.

## Deleting a profile

Deleting a profile also deletes its progress, My List, queue, playlists and settings. Any browser session or app that had it active falls back to the owner profile. Deleting the account deletes all of its profiles.

## Related

- [Users and security](../using/users-and-security.md)
- [Player](../using/player.md)
- [Arclight app](../using/arclight-app.md)
