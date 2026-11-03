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

## Content limits

A profile's limit is added to the account's caps, and the stricter of the two wins for each rating. For example, if the account is capped at R and the profile at PG, the profile sees PG and below. If the account is capped at PG-13 and the profile has no limit, the profile sees PG-13 and below.

Arclight enforces limits on the server, not just in the interface. Titles above the limit are left out of browse rows, search, details, the featured banner, My List and scrub thumbnails. Stream and artwork links signed for a limited profile carry that profile, so copying a link out of a Kids profile still won't play a restricted title. A link whose profile has since been deleted stops working.

## PINs

A PIN keeps someone from switching into a profile they shouldn't use, such as the owner profile from a Kids profile. Arclight asks for it when someone switches to that profile.

- After 5 wrong PINs within 15 minutes, switching to that profile is locked for up to 15 minutes. Arclight tells the app how long to wait. The count is kept separately for each sign-in and device.
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
